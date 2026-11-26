'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DECLARATION_INTENTS,
  normalizeSharedDeclaration,
  normalizeTargetDeclaration,
  normalizeSpecialSettings,
  resolveDeclaration
} = require('../app/core/publish-settings.cjs');

const labelOf = (intent) => DECLARATION_INTENTS.find((item) => item.id === intent).label;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function assertChineseError(fn) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, /[\u4e00-\u9fa5]/);
    return true;
  });
}

test('共同声明为空时默认为 none，合法输入返回新对象', () => {
  assert.deepEqual(normalizeSharedDeclaration(undefined), { intent: 'none' });
  assert.deepEqual(normalizeSharedDeclaration(null), { intent: 'none' });

  const input = deepFreeze({ intent: 'ai_generated' });
  const result = normalizeSharedDeclaration(input);
  assert.deepEqual(result, { intent: 'ai_generated' });
  assert.notEqual(result, input);
  result.intent = 'personal_opinion';
  assert.equal(input.intent, 'ai_generated');
});

test('未知或不完整的共同意图被拒绝且错误含中文', () => {
  assertChineseError(() => normalizeSharedDeclaration({ intent: 'unknown' }));
  assertChineseError(() => normalizeSharedDeclaration({}));
  assertChineseError(() => normalizeSharedDeclaration('ai_generated'));
});

test('旧目标声明默认值与文本裁剪规则', () => {
  assert.deepEqual(normalizeTargetDeclaration(undefined), { required: false, text: '' });
  assert.deepEqual(normalizeTargetDeclaration(null), { required: false, text: '' });

  const legacy = normalizeTargetDeclaration({ required: true, text: '  保留这段文字  ' });
  assert.deepEqual(legacy, { required: true, text: '保留这段文字' });
  assert.equal(Object.hasOwn(legacy, 'mode'), false);
  assert.equal(Object.hasOwn(legacy, 'intent'), false);

  const longText = normalizeTargetDeclaration({ text: '  ' + '甲'.repeat(600) + '  ' });
  assert.equal(longText.text.length, 500);
  assert.equal(longText.text, '甲'.repeat(500));
  assert.equal(normalizeTargetDeclaration({ text: 12345 }).text, '12345');
});

test('可选 mode/intent 仅在显式存在时保留，非法值被拒绝', () => {
  const input = deepFreeze({
    required: false,
    text: '独立声明',
    mode: 'override',
    intent: 'personal_opinion'
  });
  const result = normalizeTargetDeclaration(input);
  assert.deepEqual(result, {
    required: false,
    text: '独立声明',
    mode: 'override',
    intent: 'personal_opinion'
  });
  assert.notEqual(result, input);

  for (const mode of ['inherit', 'override', 'omit']) {
    assert.equal(normalizeTargetDeclaration({ mode }).mode, mode);
  }
  for (const intent of ['none', 'ai_generated', 'personal_opinion']) {
    assert.equal(normalizeTargetDeclaration({ intent }).intent, intent);
  }

  assertChineseError(() => normalizeTargetDeclaration({ mode: 'ignore' }));
  assertChineseError(() => normalizeTargetDeclaration({ intent: 'unknown' }));
});

test('抖音特殊设置严格枚举，只返回明确提供的合法键', () => {
  assert.deepEqual(normalizeSpecialSettings('douyin', undefined), {});
  assert.deepEqual(normalizeSpecialSettings('douyin', null), {});

  const input = deepFreeze({ visibility: 'friends', savePermission: 'deny' });
  assert.deepEqual(normalizeSpecialSettings('douyin', input), {
    visibility: 'friends',
    savePermission: 'deny'
  });
  assert.deepEqual(normalizeSpecialSettings('douyin', { visibility: 'self' }), {
    visibility: 'self'
  });
  assert.deepEqual(normalizeSpecialSettings('douyin', {}), {});

  assertChineseError(() => normalizeSpecialSettings('douyin', { visibility: 'public_to_all' }));
  assertChineseError(() => normalizeSpecialSettings('douyin', { savePermission: 'ask' }));
  assertChineseError(() => normalizeSpecialSettings('douyin', { download: 'allow' }));
  assertChineseError(() => normalizeSpecialSettings('douyin', { visibility: undefined }));
});

test('其他平台不接受抖音特殊字段，空设置仍可接受', () => {
  assert.deepEqual(normalizeSpecialSettings('xiaohongshu', {}), {});
  assert.deepEqual(normalizeSpecialSettings('weibo', null), {});
  assertChineseError(() => normalizeSpecialSettings('xiaohongshu', { visibility: 'self' }));
  assertChineseError(() => normalizeSpecialSettings('tencent', { savePermission: 'allow' }));
});

test('共同设置更新会影响继承平台', () => {
  const declaration = { mode: 'inherit' };

  const before = resolveDeclaration({ intent: 'none' }, declaration, 'douyin');
  assert.deepEqual(before, {
    required: false,
    text: '',
    intent: 'none',
    origin: 'platform',
    nativeText: null,
    verification: 'unverified'
  });

  const after = resolveDeclaration({ intent: 'ai_generated' }, declaration, 'douyin');
  assert.deepEqual(after, {
    required: true,
    text: labelOf('ai_generated'),
    intent: 'ai_generated',
    origin: 'shared',
    nativeText: '内容由AI生成',
    verification: 'page_observed'
  });
});

test('独立覆盖不受共同设置影响，且共享意图优先于独立 none', () => {
  const override = { mode: 'override', intent: 'personal_opinion' };
  const withShared = resolveDeclaration({ intent: 'ai_generated' }, override, 'douyin');
  assert.deepEqual(withShared, {
    required: true,
    text: labelOf('personal_opinion'),
    intent: 'personal_opinion',
    origin: 'platform',
    nativeText: '内容为个人观点或见解',
    verification: 'page_observed'
  });

  const afterSharedChange = resolveDeclaration({ intent: 'none' }, override, 'douyin');
  assert.deepEqual(afterSharedChange, withShared);

  const inherited = resolveDeclaration(
    { intent: 'ai_generated' },
    { mode: 'inherit', intent: 'none', required: true, text: '旧文字' },
    'douyin'
  );
  assert.equal(inherited.intent, 'ai_generated');
  assert.equal(inherited.origin, 'shared');
  assert.equal(inherited.text, labelOf('ai_generated'));
});

test('omit 主动不设置，忽略共享与独立声明', () => {
  const result = resolveDeclaration(
    { intent: 'ai_generated' },
    { mode: 'omit', intent: 'personal_opinion', required: true, text: '不应出现' },
    'douyin'
  );
  assert.deepEqual(result, {
    required: false,
    text: '',
    intent: 'none',
    origin: 'platform',
    nativeText: null,
    verification: 'unverified'
  });
});

test('旧独立声明不被新共同设置覆盖', () => {
  const declaration = { required: true, text: '账号自己的声明' };
  const first = resolveDeclaration({ intent: 'none' }, declaration, 'douyin');
  const second = resolveDeclaration({ intent: 'ai_generated' }, declaration, 'douyin');

  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    required: true,
    text: '账号自己的声明',
    intent: 'none',
    origin: 'platform',
    nativeText: null,
    verification: 'unverified'
  });
});

test('没有共享意图且旧要求不明确时不保留旧值', () => {
  const result = resolveDeclaration(
    { intent: 'none' },
    { required: false, text: '   ' },
    'douyin'
  );
  assert.deepEqual(result, {
    required: false,
    text: '',
    intent: 'none',
    origin: 'platform',
    nativeText: null,
    verification: 'unverified'
  });
  assert.deepEqual(resolveDeclaration(null, null, 'douyin'), result);
});

test('抖音发布页的五种声明严格对应原文，未核对平台不盲目生成', () => {
  for (const platform of ['weibo', 'unknown']) {
    const result = resolveDeclaration(
      { intent: 'ai_generated' },
      { mode: 'inherit' },
      platform
    );
    assert.equal(result.required, true);
    assert.equal(result.intent, 'ai_generated');
    assert.equal(result.origin, 'shared');
    assert.equal(result.nativeText, null);
    assert.equal(result.verification, 'unverified');
  }

  const opinion = resolveDeclaration(
    { intent: 'personal_opinion' },
    { mode: 'inherit' },
    'douyin'
  );
  assert.equal(opinion.nativeText, '内容为个人观点或见解');
  assert.equal(opinion.verification, 'page_observed');
  const extra = { reposted:'内容为转载信息', marketing:'内容含营销推广信息', fictional:'虚构演绎，仅供娱乐' };
  for (const [intent, nativeText] of Object.entries(extra)) {
    const declaration = {mode:'override',intent};
    assert.equal(resolveDeclaration(null,declaration,'douyin').nativeText,nativeText);
    assert.equal(resolveDeclaration(null,declaration,'douyin').verification,'page_observed');
    assert.equal(resolveDeclaration(null,declaration,'unknown').nativeText,null);
    assertChineseError(()=>normalizeSharedDeclaration({intent}));
  }
});

test('视频号映射真实下拉菜单原文，未知平台仍保持未核对', () => {
  const settings = require('../app/core/publish-settings.cjs');
  for (const [intent, text] of Object.entries(settings.TENCENT_DECLARATIONS)) {
    const value = resolveDeclaration(null, { mode: 'override', intent }, 'tencent');
    assert.equal(value.nativeText, text);
    assert.equal(value.verification, 'page_observed');
  }
  assert.equal(resolveDeclaration(null, { mode: 'override', intent: 'personal_opinion' }, 'unknown').nativeText, null);
});

test('参数与返回值互不共享引用，解析结果字段完整', () => {
  const shared = deepFreeze({ intent: 'ai_generated' });
  const declaration = deepFreeze({
    required: true,
    text: '  旧声明  ',
    mode: 'inherit',
    intent: 'none'
  });
  const sharedSnapshot = JSON.parse(JSON.stringify(shared));
  const declarationSnapshot = JSON.parse(JSON.stringify(declaration));

  const result = resolveDeclaration(shared, declaration, 'douyin');
  assert.deepEqual(shared, sharedSnapshot);
  assert.deepEqual(declaration, declarationSnapshot);
  assert.deepEqual(
    Object.keys(result).sort(),
    ['intent', 'nativeText', 'origin', 'required', 'text', 'verification'].sort()
  );

  result.text = '被修改';
  assert.equal(shared.intent, 'ai_generated');
  assert.equal(declaration.text, '  旧声明  ');
});

test('非法声明在解析入口被拒绝且错误含中文', () => {
  assertChineseError(() => resolveDeclaration({ intent: 'unknown' }, { mode: 'inherit' }, 'douyin'));
  assertChineseError(() => resolveDeclaration(null, { mode: 'bad' }, 'douyin'));
  assertChineseError(() => resolveDeclaration(null, { intent: 'bad' }, 'douyin'));
});

test('小红书仅映射真实菜单已见原文，个人观点须明确提示而非丢弃',()=>{
  const settings=require('../app/core/publish-settings.cjs');
  for(const [intent,text] of Object.entries(settings.XIAOHONGSHU_DECLARATIONS)){
    const value=resolveDeclaration(null,{mode:'override',intent},'xiaohongshu');
    assert.equal(value.nativeText,text);assert.equal(value.verification,'page_observed');
  }
  const shared={intent:'personal_opinion'};
  assert.match(settings.declarationIssue('xiaohongshu',resolveDeclaration(shared,{mode:'inherit'},'xiaohongshu')),/不提供.*个人观点/);
  assert.equal(settings.declarationIssue('xiaohongshu',resolveDeclaration(shared,{mode:'omit'},'xiaohongshu')),'');
  assert.equal(settings.declarationIssue('tencent',resolveDeclaration(shared,{mode:'inherit'},'tencent')),'');
});
