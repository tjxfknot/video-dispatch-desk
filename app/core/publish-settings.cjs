(function (global) {
'use strict';

const INTENT_IDS = Object.freeze(['none', 'ai_generated', 'personal_opinion', 'reposted', 'marketing', 'fictional']);
const SHARED_INTENT_IDS = Object.freeze(['none', 'ai_generated', 'personal_opinion']);
const INTENT_LABELS = Object.freeze({
  none: '不统一设置',
  ai_generated: '含 AI 生成内容',
  personal_opinion: '个人观点或见解',
  reposted: '转载信息',
  marketing: '营销推广信息',
  fictional: '虚构演绎，仅供娱乐'
});

const DECLARATION_INTENTS = Object.freeze([
  Object.freeze({ id: 'none', label: INTENT_LABELS.none }),
  Object.freeze({ id: 'ai_generated', label: INTENT_LABELS.ai_generated }),
  Object.freeze({ id: 'personal_opinion', label: INTENT_LABELS.personal_opinion }),
  Object.freeze({ id: 'reposted', label: INTENT_LABELS.reposted }),
  Object.freeze({ id: 'marketing', label: INTENT_LABELS.marketing }),
  Object.freeze({ id: 'fictional', label: INTENT_LABELS.fictional })
]);

// 2026-11-06，夸克中已登录的抖音发布页。这里只记录看到的单选原文，
// 不代表程序已经会操作控件，也不代表其他账号或平台提供相同选项。
const DOUYIN_DECLARATIONS = Object.freeze({
  ai_generated: '内容由AI生成',
  personal_opinion: '内容为个人观点或见解',
  reposted: '内容为转载信息',
  marketing: '内容含营销推广信息',
  fictional: '虚构演绎，仅供娱乐'
});
// 2026-11-08，当前已登录小红书创作后台的内容类型菜单原文。
const XIAOHONGSHU_DECLARATIONS = Object.freeze({
  ai_generated: '笔记含AI合成内容',
  fictional: '虚构演绎，仅供娱乐',
  marketing: '内容包含营销广告'
});
// 2026-11-21，当前已登录视频号助手“选择视频标注”下拉菜单原文。
const TENCENT_DECLARATIONS = Object.freeze({
  ai_generated: '含AI生成内容',
  personal_opinion: '个人观点，仅供参考',
  fictional: '内容为虚构剧情，仅供娱乐',
  marketing: '内容包含营销广告',
  reposted: '内容为转载'
});

function declarationIssue(platform, declaration) {
  if (platform === 'xiaohongshu' && declaration.required && declaration.intent === 'personal_opinion') {
    return '小红书当前不提供“个人观点或见解”声明。请在小红书卡片选择“本平台不设置声明”，或单独选择该平台支持的声明；其他平台的共同声明会保留。';
  }
  return '';
}

const DECLARATION_MODES = Object.freeze(['inherit', 'override', 'omit']);
const SPECIAL_ENUMS = Object.freeze({
  visibility: Object.freeze(['platform_default', 'public', 'friends', 'self']),
  savePermission: Object.freeze(['platform_default', 'allow', 'deny'])
});

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntent(value) {
  return INTENT_IDS.includes(value);
}

function normalizeSharedDeclaration(value) {
  if (value === undefined || value === null) {
    return { intent: 'none' };
  }
  if (!isRecord(value)) {
    throw new TypeError('共同声明必须是对象或为空');
  }
  if (!hasOwn(value, 'intent') || !SHARED_INTENT_IDS.includes(value.intent)) {
    throw new TypeError('共同声明包含未知或不受支持的声明意图');
  }
  return { intent: value.intent };
}

function normalizeTargetDeclaration(value) {
  if (value === undefined || value === null) {
    return { required: false, text: '' };
  }
  if (!isRecord(value)) {
    throw new TypeError('目标声明必须是对象或为空');
  }

  const result = {
    required: value.required === true,
    text: String(value.text == null ? '' : value.text).trim().slice(0, 500)
  };

  if (hasOwn(value, 'mode')) {
    if (!DECLARATION_MODES.includes(value.mode)) {
      throw new TypeError('目标声明包含未知或不受支持的声明模式');
    }
    result.mode = value.mode;
  }

  if (hasOwn(value, 'intent')) {
    if (!isIntent(value.intent)) {
      throw new TypeError('目标声明包含未知或不受支持的声明意图');
    }
    result.intent = value.intent;
  }

  return result;
}

function normalizeSpecialSettings(platform, value) {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new TypeError('平台特殊设置必须是对象或为空');
  }

  const keys = Object.keys(value);
  if (platform !== 'douyin') {
    if (keys.length > 0) {
      throw new TypeError('该平台不支持特殊设置，不能套用抖音字段');
    }
    return {};
  }

  const result = {};
  for (const key of keys) {
    if (!hasOwn(SPECIAL_ENUMS, key)) {
      throw new TypeError('抖音特殊设置包含未知字段：' + key);
    }
    if (!SPECIAL_ENUMS[key].includes(value[key])) {
      throw new TypeError('抖音特殊设置字段 ' + key + ' 的取值不受支持');
    }
    result[key] = value[key];
  }
  return result;
}

function normalizeLocation(value) {
  if (!isRecord(value) || !['none', 'place'].includes(value.mode)
    || Object.keys(value).some(key => !['mode', 'name'].includes(key))) throw new TypeError('定位设置格式不正确，请选择不添加定位或添加指定地点。');
  const name = value.name === undefined ? '' : value.name;
  if (typeof name !== 'string' || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw new TypeError('地点名称需为不超过100字的文字。');
  return { mode: value.mode, name: value.mode === 'place' ? name.trim() : '' };
}

function locationLabel(value) {
  if (value === undefined) return '历史任务未记录定位选择';
  const location = normalizeLocation(value);
  return location.mode === 'none' ? '不添加定位' : `添加定位：${location.name || '尚未填写地点'}`;
}

function resolveDeclaration(shared, declaration, platform) {
  const sharedDeclaration = normalizeSharedDeclaration(shared);
  const targetDeclaration = normalizeTargetDeclaration(declaration);

  const mode = hasOwn(targetDeclaration, 'mode')
    ? targetDeclaration.mode
    : targetDeclaration.required
      ? 'override'
      : 'inherit';

  if (mode === 'omit') {
    return {
      required: false,
      text: '',
      intent: 'none',
      origin: 'platform',
      nativeText: null,
      verification: 'unverified'
    };
  }

  let required = false;
  let text = '';
  let intent = 'none';
  let origin = 'platform';

  if (mode === 'inherit' && sharedDeclaration.intent !== 'none') {
    intent = sharedDeclaration.intent;
    required = true;
    text = INTENT_LABELS[intent];
    origin = 'shared';
  } else if (targetDeclaration.intent && targetDeclaration.intent !== 'none') {
    intent = targetDeclaration.intent;
    required = true;
    text = INTENT_LABELS[intent];
  } else if (targetDeclaration.required) {
    required = targetDeclaration.required;
    text = targetDeclaration.text;
  }

  let nativeText = null;
  let verification = 'unverified';
  if (platform === 'douyin' && hasOwn(DOUYIN_DECLARATIONS, intent)) {
    nativeText = DOUYIN_DECLARATIONS[intent];
    verification = 'page_observed';
  } else if (platform === 'xiaohongshu' && hasOwn(XIAOHONGSHU_DECLARATIONS, intent)) {
    nativeText = XIAOHONGSHU_DECLARATIONS[intent];
    verification = 'page_observed';
  } else if (platform === 'tencent' && hasOwn(TENCENT_DECLARATIONS, intent)) {
    nativeText = TENCENT_DECLARATIONS[intent];
    verification = 'page_observed';
  }

  return { required, text, intent, origin, nativeText, verification };
}

const api = {
  DECLARATION_INTENTS,
  DOUYIN_DECLARATIONS,
  XIAOHONGSHU_DECLARATIONS,
  TENCENT_DECLARATIONS,
  declarationIssue,
  normalizeSharedDeclaration,
  normalizeTargetDeclaration,
  normalizeSpecialSettings,
  normalizeLocation,
  locationLabel,
  resolveDeclaration
};

if (typeof module === 'object' && module.exports) module.exports = api;
else global.PublishSettings = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
