'use strict';

const { randomUUID } = require('node:crypto');

const PLATFORM_IDS = Object.freeze(['douyin', 'tencent', 'xiaohongshu']);
const PLATFORM_SET = new Set(PLATFORM_IDS);
const PLATFORM_LABELS = Object.freeze({
  douyin: '抖音', tencent: '视频号', xiaohongshu: '小红书'
});
const MAX_PROFILE_ACCOUNTS = 16;
// 仅专属浏览器支持三平台；旧扩展协议仍只允许抖音，两个集合不得混用。
const MANAGED_BROWSER_PLATFORMS = new Set(PLATFORM_IDS);
const BINDABLE_PLATFORMS = new Set(['douyin']);
const ACCOUNT_STATUSES = new Set(['unconnected', 'connected', 'bound']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORM_ACCOUNT_PATTERN = /^[A-Za-z0-9_.-]{3,64}$/;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const CORE_ARRAY_KEYS = Object.freeze(['assets', 'accounts', 'templates', 'drafts', 'runs', 'teachers', 'environments']);

const clone = value => structuredClone(value);

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertStore(store) {
  if (!store || typeof store.load !== 'function' || typeof store.update !== 'function') {
    fail('数据存储接口不可用，无法读写账号数据。');
  }
}

function requireId(value, field) {
  if (typeof value !== 'string') fail(`${field}格式不正确。`);
  if (CONTROL_PATTERN.test(value)) fail(`${field}不能包含控制字符。`);
  const id = value.trim();
  if (!id) fail(`${field}不能为空。`);
  if (id.length > 200) fail(`${field}过长。`);
  return id;
}

function requireDisplayText(value, field, limit) {
  if (typeof value !== 'string') fail(`${field}必须是文本。`);
  if (CONTROL_PATTERN.test(value)) fail(`${field}不能包含控制字符。`);
  const text = value.trim();
  if (!text) fail(`${field}不能为空。`);
  if (text.length > limit) fail(`${field}不能超过${limit}个字符。`);
  return text;
}

function requireOptionalText(value, field, limit) {
  if (typeof value !== 'string') fail(`${field}必须是文本。`);
  if (CONTROL_PATTERN.test(value)) fail(`${field}不能包含控制字符。`);
  const text = value.trim();
  if (text.length > limit) fail(`${field}不能超过${limit}个字符。`);
  return text;
}

function isDateString(value) {
  return typeof value === 'string' && value.length > 0 && !CONTROL_PATTERN.test(value)
    && !Number.isNaN(Date.parse(value));
}

function requireDateString(value, field) {
  if (!isDateString(value)) fail(`${field}必须是有效的日期时间字符串。`);
  return value.trim();
}

function requireUuid(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail(`${field}必须是UUID。`);
  return value;
}

function requirePlatformAccountId(value) {
  if (typeof value !== 'string' || !PLATFORM_ACCOUNT_PATTERN.test(value)) {
    fail('真实账号格式不正确，必须是3–64位ASCII字母、数字、下划线、点或横线。');
  }
  return value;
}

function normalizeDefaultPlatforms(value) {
  if (!Array.isArray(value)) fail('默认平台必须是数组。');
  if (value.length > PLATFORM_IDS.length) fail(`默认平台最多${PLATFORM_IDS.length}项。`);
  const platforms = [];
  const seen = new Set();
  for (const platform of value) {
    if (typeof platform !== 'string' || !PLATFORM_SET.has(platform)) fail('默认平台包含无法识别的平台。');
    if (seen.has(platform)) fail('默认平台不能重复。');
    seen.add(platform);
    platforms.push(platform);
  }
  return platforms;
}

function projectTeacher(teacher) {
  return {
    id: teacher.id,
    name: teacher.name,
    createdAt: teacher.createdAt,
    defaultPlatforms: [...teacher.defaultPlatforms]
  };
}

function projectEnvironment(environment) {
  const projected = {
    id: environment.id,
    connectorInstanceId: environment.connectorInstanceId,
    label: environment.label,
    deviceId: environment.deviceId,
    createdAt: environment.createdAt,
    lastSeenAt: environment.lastSeenAt
  };
  // 专属浏览器公开老师归属；旧扩展环境保持原有白名单，避免旧快照字段扩张。
  if (environment.source === 'managed_browser') {
    projected.source = environment.source;
    projected.browserKind = environment.browserKind;
    projected.teacherId = environment.teacherId;
  }
  if (environment.platform !== undefined) projected.platform = environment.platform;
  return projected;
}

function projectBinding(binding) {
  if (!binding) return null;
  return {
    environmentId: binding.environmentId,
    connectorInstanceId: binding.connectorInstanceId,
    platformAccountId: binding.platformAccountId,
    displayName: binding.displayName,
    verifiedAt: binding.verifiedAt,
    revision: binding.revision,
    ...(binding.source === 'managed_browser' ? { source: binding.source } : {})
  };
}

function projectAccount(account) {
  return {
    id: account.id,
    platform: account.platform,
    label: account.label,
    status: account.status,
    createdAt: account.createdAt,
    teacherId: account.teacherId ?? null,
    binding: projectBinding(account.binding),
    ...(account.browserEnvironmentId ? { browserEnvironmentId: account.browserEnvironmentId } : {})
  };
}

function validateTeacherRecord(teacher, teacherIds) {
  if (!isPlainObject(teacher)) fail('老师数据格式无法识别。');
  if (typeof teacher.id !== 'string' || !teacher.id.trim()) fail('老师ID格式无法识别。');
  if (teacherIds.has(teacher.id)) fail('老师数据存在重复ID，程序不会覆盖现有数据。');
  teacherIds.add(teacher.id);
  if (typeof teacher.name !== 'string' || !teacher.name.trim()) fail('老师姓名格式无法识别。');
  if (CONTROL_PATTERN.test(teacher.name)) fail('老师姓名包含控制字符。');
  if (teacher.name.trim().length > 100) fail('老师姓名不能超过100个字符。');
  if (!isDateString(teacher.createdAt)) fail('老师创建时间格式无法识别。');
  if (teacher.defaultPlatforms === undefined) teacher.defaultPlatforms = [];
  else teacher.defaultPlatforms = normalizeDefaultPlatforms(teacher.defaultPlatforms);
}

function validateEnvironmentRecord(environment, environmentIds, teacherIds) {
  if (!isPlainObject(environment)) fail('浏览器环境数据格式无法识别。');
  requireUuid(environment.id, '浏览器环境ID');
  if (environment.platform !== undefined && !MANAGED_BROWSER_PLATFORMS.has(environment.platform)) {
    fail('浏览器环境平台无法识别。');
  }
  if (environment.source === 'managed_browser') {
    if (environment.connectorInstanceId !== null || !['chrome', 'msedge'].includes(environment.browserKind)
      || !teacherIds.has(environment.teacherId)) fail('专属浏览器环境格式不正确。');
  } else {
    if (environment.source !== undefined && environment.source !== 'legacy_extension') fail('浏览器环境来源无法识别。');
    const connectorInstanceId = requireUuid(environment.connectorInstanceId, '浏览器环境连接实例ID');
    if (environment.id !== connectorInstanceId) fail('浏览器环境ID必须等于连接实例ID。');
  }
  if (environmentIds.has(environment.id)) fail('浏览器环境数据存在重复ID，程序不会覆盖现有数据。');
  environmentIds.add(environment.id);
  if (typeof environment.label !== 'string') fail('浏览器环境备注格式无法识别。');
  if (CONTROL_PATTERN.test(environment.label)) fail('浏览器环境备注包含控制字符。');
  if (environment.label.trim().length > 100) fail('浏览器环境备注不能超过100个字符。');
  requireUuid(environment.deviceId, '浏览器环境设备ID');
  if (!isDateString(environment.createdAt)) fail('浏览器环境创建时间格式无法识别。');
  if (!isDateString(environment.lastSeenAt)) fail('浏览器环境最后在线时间格式无法识别。');
  if (environment.teacherId !== undefined && environment.teacherId !== null) {
    if (typeof environment.teacherId !== 'string' || !teacherIds.has(environment.teacherId)) {
      fail('浏览器环境所属老师不存在。');
    }
  }
}

function validateBinding(account, environmentById) {
  const binding = account.binding;
  if (!isPlainObject(binding)) fail('账号绑定数据格式无法识别。');
  const environmentId = requireUuid(binding.environmentId, '绑定环境ID');
  if (binding.source === 'managed_browser') {
    if (binding.connectorInstanceId !== null || account.browserEnvironmentId !== environmentId) fail('专属浏览器绑定数据不一致。');
  } else {
    if (binding.source !== undefined && binding.source !== 'legacy_extension') fail('绑定来源无法识别。');
    const connectorInstanceId = requireUuid(binding.connectorInstanceId, '绑定连接实例ID');
    if (environmentId !== connectorInstanceId) fail('账号绑定中的环境ID与连接实例ID不一致。');
  }
  requirePlatformAccountId(binding.platformAccountId);
  if (typeof binding.displayName !== 'string') fail('绑定显示名称格式无法识别。');
  if (CONTROL_PATTERN.test(binding.displayName)) fail('绑定显示名称包含控制字符。');
  if (binding.displayName.trim().length > 120) fail('绑定显示名称不能超过120个字符。');
  if (!isDateString(binding.verifiedAt)) fail('绑定核验时间格式无法识别。');
  requireUuid(binding.revision, '绑定版本号');
  if (account.status !== 'bound') fail('账号绑定状态与绑定数据不一致。');
  if (account.teacherId === null) fail('已绑定账号尚未分配老师，数据不一致。');

  const environment = environmentById.get(environmentId);
  if (!environment) fail('账号绑定引用的浏览器环境不存在，数据不一致。');
  if ((binding.source === 'managed_browser') !== (environment.source === 'managed_browser')
    || environment.connectorInstanceId !== binding.connectorInstanceId) {
    fail('账号绑定引用的浏览器环境连接实例不一致。');
  }
  if (environment.platform !== undefined && environment.platform !== account.platform) {
    fail('账号绑定的浏览器环境平台与账号平台不一致。');
  }
  return environment;
}

function ensureStateObject(state) {
  if (!isPlainObject(state)) fail('数据根节点必须是对象。');
  if (state.schemaVersion !== 1) {
    fail('数据版本或格式无法识别，请保留原文件并联系维护者；程序不会覆盖现有数据。');
  }
  for (const key of CORE_ARRAY_KEYS) {
    if (state[key] === undefined) state[key] = [];
    else if (!Array.isArray(state[key])) fail(`数据字段${key}必须是数组。`);
  }
  if (state.deviceId === undefined) state.deviceId = randomUUID();
  else requireUuid(state.deviceId, 'deviceId');

  const teacherIds = new Set();
  for (const teacher of state.teachers) validateTeacherRecord(teacher, teacherIds);

  const environmentIds = new Set();
  const environmentById = new Map();
  for (const environment of state.environments) {
    validateEnvironmentRecord(environment, environmentIds, teacherIds);
    environmentById.set(environment.id, environment);
  }

  const accountIds = new Set();
  const boundNumbers = new Map();
  const environmentSlots = new Map();
  const environmentTeachers = new Map();

  for (const account of state.accounts) {
    if (!isPlainObject(account)) fail('账号数据格式无法识别。');
    if (typeof account.id !== 'string' || !account.id.trim()) fail('账号ID格式无法识别。');
    if (accountIds.has(account.id)) fail('账号数据存在重复ID，程序不会覆盖现有数据。');
    accountIds.add(account.id);
    if (!PLATFORM_SET.has(account.platform)) fail('账号平台无法识别。');
    if (typeof account.label !== 'string' || !account.label.trim()) fail('账号备注格式无法识别。');
    if (CONTROL_PATTERN.test(account.label)) fail('账号备注包含控制字符。');
    if (account.label.trim().length > 100) fail('账号备注不能超过100个字符。');
    if (!ACCOUNT_STATUSES.has(account.status)) fail('账号状态无法识别。');
    if (!isDateString(account.createdAt)) fail('账号创建时间格式无法识别。');

    if (account.teacherId === undefined) account.teacherId = null;
    else if (account.teacherId !== null) {
      if (typeof account.teacherId !== 'string' || !teacherIds.has(account.teacherId)) {
        fail('账号所属老师不存在。');
      }
    }

    if (account.binding === undefined) account.binding = null;
    if (account.browserEnvironmentId !== undefined) {
      const env = environmentById.get(requireUuid(account.browserEnvironmentId, '专属浏览器环境ID'));
      if (!env || env.source !== 'managed_browser' || env.teacherId !== account.teacherId) fail('账号的专属浏览器归属不一致。');
      if (env.platform !== undefined && env.platform !== account.platform) fail('账号的专属浏览器平台与账号平台不一致。');
    }
    if (account.binding === null) {
      if (account.status === 'bound') fail('账号绑定状态与绑定数据不一致。');
      continue;
    }

    const environment = validateBinding(account, environmentById);
    if (boundNumbers.has(`${account.platform}\u0000${account.binding.platformAccountId}`)) {
      fail('同一真实账号被重复绑定，程序不会覆盖现有数据。');
    }
    boundNumbers.set(`${account.platform}\u0000${account.binding.platformAccountId}`, account.id);

    const slot = `${environment.id}\u0000${account.platform}`;
    if (environmentSlots.has(slot)) fail('同一浏览器环境同一平台绑定了多个账号，数据不一致。');
    environmentSlots.set(slot, account.id);

    const existingTeacherId = environmentTeachers.get(environment.id);
    if (existingTeacherId !== undefined && existingTeacherId !== account.teacherId) {
      fail('同一浏览器环境关联了不同老师，数据不一致。');
    }
    environmentTeachers.set(environment.id, account.teacherId);

    if (environment.teacherId !== undefined && environment.teacherId !== null
      && environment.teacherId !== account.teacherId) {
      fail('浏览器环境所属老师与账号老师不一致。');
    }
  }
}

function ensureAccountState(store) {
  assertStore(store);
  const before = store.load();
  const checked = clone(before);
  ensureStateObject(checked);
  if (JSON.stringify(before) !== JSON.stringify(checked)) store.update(state => ensureStateObject(state));
  return clone(store.load());
}

function saveTeacher(store, input) {
  assertStore(store);
  if (!isPlainObject(input)) fail('老师参数格式不正确。');
  const name = requireDisplayText(input.name, '老师姓名', 100);
  const hasId = input.id !== undefined;
  const id = hasId ? requireId(input.id, '老师ID') : null;
  const hasDefaultPlatforms = input.defaultPlatforms !== undefined;
  const defaultPlatforms = hasDefaultPlatforms ? normalizeDefaultPlatforms(input.defaultPlatforms) : null;

  let result;
  store.update(state => {
    ensureStateObject(state);
    let teacher;
    if (hasId) {
      teacher = state.teachers.find(item => item.id === id);
      if (!teacher) fail('老师不存在，未知ID不会创建新老师。');
      teacher.name = name;
      if (hasDefaultPlatforms) teacher.defaultPlatforms = [...defaultPlatforms];
    } else {
      teacher = {
        id: randomUUID(),
        name,
        createdAt: new Date().toISOString(),
        defaultPlatforms: hasDefaultPlatforms ? [...defaultPlatforms] : []
      };
      state.teachers.push(teacher);
    }
    result = projectTeacher(teacher);
  });
  return clone(result);
}

function normalizeProfileAccounts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('账号列表必须是数组。');
  if (value.length > MAX_PROFILE_ACCOUNTS) fail(`账号列表最多${MAX_PROFILE_ACCOUNTS}项。`);
  const ids = new Set();
  const newPlatforms = new Set();
  return Array.from(value, item => {
    if (!isPlainObject(item)) fail('账号参数格式不正确。');
    const hasId = item.id !== undefined;
    const id = hasId ? requireId(item.id, '账号ID') : null;
    if (hasId) {
      if (ids.has(id)) fail('同一请求中的账号ID不能重复。');
      ids.add(id);
    }
    if (typeof item.platform !== 'string' || !PLATFORM_SET.has(item.platform)) fail('请选择正确的平台。');
    const label = requireDisplayText(item.label, '账号备注', 100);
    if (!hasId) {
      if (newPlatforms.has(item.platform)) fail('同一平台最多只能新增一个不带ID的账号。');
      newPlatforms.add(item.platform);
    }
    return { hasId, id, platform: item.platform, label };
  });
}

function saveTeacherProfile(store, input) {
  assertStore(store);
  if (!isPlainObject(input)) fail('老师档案参数格式不正确。');
  const name = requireDisplayText(input.name, '老师姓名', 100);
  const hasId = input.id !== undefined;
  const id = hasId ? requireId(input.id, '老师ID') : null;
  const hasDefaultPlatforms = input.defaultPlatforms !== undefined;
  const defaultPlatforms = hasDefaultPlatforms ? normalizeDefaultPlatforms(input.defaultPlatforms) : null;
  const accountInputs = normalizeProfileAccounts(input.accounts);

  let result;
  store.update(state => {
    ensureStateObject(state);
    let teacher;
    if (hasId) {
      teacher = state.teachers.find(item => item.id === id);
      if (!teacher) fail('老师不存在，未知ID不会创建新老师。');
    } else {
      teacher = { id: randomUUID(), name, createdAt: new Date().toISOString(), defaultPlatforms: [] };
      state.teachers.push(teacher);
    }
    teacher.name = name;
    if (hasDefaultPlatforms) teacher.defaultPlatforms = [...defaultPlatforms];

    const updates = [];
    const additions = [];
    for (const item of accountInputs) {
      if (!item.hasId) {
        const existing = state.accounts.find(account => account.teacherId === teacher.id
          && account.platform === item.platform);
        if (existing) fail(`该老师已有${PLATFORM_LABELS[item.platform]}账号，请使用现有账号ID修改备注。`);
        additions.push(item);
        continue;
      }
      const account = state.accounts.find(itemAccount => itemAccount.id === item.id);
      if (!account) fail('账号不存在，未知账号ID不会创建新账号。');
      if (account.teacherId !== teacher.id) fail('账号不属于该老师，不能修改。');
      if (account.platform !== item.platform) fail('账号平台与请求不一致，不能修改。');
      updates.push({ account, label: item.label });
    }

    for (const { account, label } of updates) account.label = label;
    const now = new Date().toISOString();
    for (const item of additions) {
      state.accounts.push({
        id: randomUUID(),
        platform: item.platform,
        label: item.label,
        status: 'unconnected',
        createdAt: now,
        teacherId: teacher.id,
        binding: null
      });
    }
    for (const platform of teacher.defaultPlatforms) {
      if (state.accounts.some(account => account.teacherId === teacher.id
        && account.platform === platform)) continue;
      const suffix = ` · ${PLATFORM_LABELS[platform]}`;
      state.accounts.push({
        id: randomUUID(),
        platform,
        label: `${teacher.name.slice(0, 100 - suffix.length)}${suffix}`,
        status: 'unconnected',
        createdAt: now,
        teacherId: teacher.id,
        binding: null
      });
    }
    result = {
      teacher: projectTeacher(teacher),
      accounts: state.accounts.filter(account => account.teacherId === teacher.id).map(projectAccount)
    };
  });
  return clone(result);
}

function saveManagedAccount(store, input) {
  assertStore(store);
  if (!isPlainObject(input)) fail('账号参数格式不正确。');
  if (typeof input.platform !== 'string' || !PLATFORM_SET.has(input.platform)) {
    fail('请选择正确的平台。');
  }
  const platform = input.platform;
  const label = requireDisplayText(input.label, '账号备注', 100);
  const teacherId = requireId(input.teacherId, '老师ID');
  const hasId = input.id !== undefined;
  const id = hasId ? requireId(input.id, '账号ID') : null;

  let result;
  store.update(state => {
    ensureStateObject(state);
    if (!state.teachers.some(item => item.id === teacherId)) fail('所选老师不存在。');

    let account;
    if (hasId) {
      account = state.accounts.find(item => item.id === id);
      if (!account) fail('账号不存在，未知ID不会创建新账号。');
      if (account.binding) {
        if (account.teacherId !== teacherId) fail('已绑定账号不能更换老师，请先解除绑定。');
        if (account.platform !== platform) fail('已绑定账号不能更换平台，请先解除绑定。');
      } else {
        if (account.teacherId !== teacherId || account.platform !== platform) delete account.browserEnvironmentId;
        account.teacherId = teacherId;
        account.platform = platform;
      }
      account.label = label;
    } else {
      account = {
        id: randomUUID(),
        platform,
        label,
        status: 'unconnected',
        createdAt: new Date().toISOString(),
        teacherId,
        binding: null
      };
      state.accounts.push(account);
    }
    result = projectAccount(account);
  });
  return clone(result);
}

function normalizeBindInput(input, now) {
  if (!isPlainObject(input)) fail('绑定参数格式不正确。');
  const accountId = requireId(input.accountId, '账号ID');
  const connectorInstanceId = requireUuid(input.connectorInstanceId, '浏览器环境连接实例ID');
  const platformAccountId = requirePlatformAccountId(input.platformAccountId);
  const displayName = requireOptionalText(input.displayName, '绑定显示名称', 120);
  const environmentLabel = requireOptionalText(input.environmentLabel, '浏览器环境备注', 100);
  const verifiedAt = now === undefined ? new Date().toISOString() : requireDateString(now, '绑定核验时间');
  return { accountId, connectorInstanceId, platformAccountId, displayName, environmentLabel, verifiedAt };
}

function bindManagedAccount(store, input, now) {
  // 仅供主线程在连接服务核对身份、且用户确认后调用；不作为 renderer 直连 API。
  assertStore(store);
  const params = normalizeBindInput(input, now);

  let result;
  store.update(state => {
    ensureStateObject(state);
    const account = state.accounts.find(item => item.id === params.accountId);
    if (!account) fail('账号不存在，不能绑定。');
    if (!BINDABLE_PLATFORMS.has(account.platform)) fail('当前仅支持绑定抖音账号。');
    if (account.teacherId === null || !state.teachers.some(item => item.id === account.teacherId)) {
      fail('账号尚未分配老师或老师不存在，不能绑定。');
    }

    if (account.browserEnvironmentId) fail('该账号已分配工作台专属浏览器，不能改接旧扩展。');
    let environment = state.environments.find(item => item.id === params.connectorInstanceId);
    if (environment?.source === 'managed_browser') fail('不能将专属浏览器当作扩展环境。');
    if (environment && environment.deviceId !== state.deviceId) {
      fail('该浏览器环境不属于本机，不能绑定。');
    }

    if (account.binding) {
      const sameEnvironment = account.binding.environmentId === params.connectorInstanceId
        && account.binding.connectorInstanceId === params.connectorInstanceId;
      const sameIdentity = account.binding.platformAccountId === params.platformAccountId;
      if (sameEnvironment && sameIdentity) {
        result = projectAccount(account);
        return;
      }
      fail('账号已绑定其他真实账号或浏览器环境，请先解除绑定，不能覆盖。');
    }

    const duplicate = state.accounts.find(item => item.id !== account.id
      && item.binding && item.platform === account.platform && item.binding.platformAccountId === params.platformAccountId);
    if (duplicate) fail('该真实账号已绑定其他账号记录，不能重复绑定。');

    const siblings = state.accounts.filter(item => item.id !== account.id && item.binding
      && (item.binding.environmentId === params.connectorInstanceId
        || item.binding.connectorInstanceId === params.connectorInstanceId));
    if (siblings.some(item => item.teacherId !== account.teacherId)) {
      fail('该浏览器环境已属于其他老师，不能混用。');
    }
    if (siblings.some(item => item.platform === account.platform)) {
      fail('该浏览器环境已绑定其他抖音账号，请先解除原绑定。');
    }

    if (environment) {
      if (environment.teacherId !== undefined && environment.teacherId !== null
        && environment.teacherId !== account.teacherId) {
        fail('该浏览器环境已属于其他老师，不能混用。');
      }
      environment.teacherId = account.teacherId;
      environment.lastSeenAt = params.verifiedAt;
    } else {
      // 契约未在 environment 字段清单中列出 teacherId；为在解绑后仍执行“同环境不混用不同老师”，
      // 这里只在 store 内部保存归属，snapshotAccounts 仍按契约字段投影，不对外暴露该内部字段。
      environment = {
        id: params.connectorInstanceId,
        connectorInstanceId: params.connectorInstanceId,
        label: params.environmentLabel,
        deviceId: state.deviceId,
        createdAt: params.verifiedAt,
        lastSeenAt: params.verifiedAt,
        teacherId: account.teacherId
      };
      state.environments.push(environment);
    }

    account.binding = {
      environmentId: params.connectorInstanceId,
      connectorInstanceId: params.connectorInstanceId,
      platformAccountId: params.platformAccountId,
      displayName: params.displayName,
      verifiedAt: params.verifiedAt,
      revision: randomUUID()
    };
    account.status = 'bound';
    result = projectAccount(account);
  });
  return clone(result);
}

function unbindManagedAccount(store, accountId) {
  assertStore(store);
  const id = requireId(accountId, '账号ID');

  let result;
  store.update(state => {
    ensureStateObject(state);
    const account = state.accounts.find(item => item.id === id);
    if (!account) fail('账号不存在，不能解除绑定。');
    account.binding = null;
    account.status = 'unconnected';
    result = projectAccount(account);
  });
  return clone(result);
}

function assertIdentity(store, input) {
  assertStore(store);
  if (!isPlainObject(input)) fail('核验参数格式不正确。');
  const accountId = requireId(input.accountId, '账号ID');
  const connectorInstanceId = requireUuid(input.connectorInstanceId, '浏览器环境连接实例ID');
  const platformAccountId = requirePlatformAccountId(input.platformAccountId);

  const state = store.load();
  ensureStateObject(state);

  const account = state.accounts.find(item => item.id === accountId);
  if (!account) fail('账号不存在，无法核验。');
  if (account.platform !== 'douyin') fail('当前仅支持核验抖音账号。');
  if (!account.binding) fail('账号尚未绑定真实账号，不能核验。');
  if (account.binding.source === 'managed_browser') fail('请通过工作台专属浏览器核验此账号。');
  if (account.teacherId === null || !state.teachers.some(item => item.id === account.teacherId)) {
    fail('账号所属老师不存在，不能核验。');
  }
  if (account.binding.environmentId !== connectorInstanceId
    || account.binding.connectorInstanceId !== connectorInstanceId) {
    fail('绑定环境与核验环境不一致。');
  }
  if (account.binding.platformAccountId !== platformAccountId) {
    fail('真实账号不一致，禁止只按昵称判断。');
  }

  const environment = state.environments.find(item => item.id === connectorInstanceId);
  if (!environment) fail('浏览器环境不存在或已失效。');
  if (environment.connectorInstanceId !== connectorInstanceId) {
    fail('浏览器环境记录与连接实例不一致。');
  }
  if (environment.deviceId !== state.deviceId) fail('浏览器环境不属于本机，不能核验。');
  if (environment.teacherId !== undefined && environment.teacherId !== null
    && environment.teacherId !== account.teacherId) {
    fail('该浏览器环境属于其他老师，不能核验。');
  }

  const siblings = state.accounts.filter(item => item.id !== account.id && item.binding
    && (item.binding.environmentId === environment.id
      || item.binding.connectorInstanceId === environment.id));
  if (siblings.some(item => item.teacherId !== account.teacherId)) {
    fail('该浏览器环境属于其他老师，不能核验。');
  }

  return clone(projectAccount(account));
}

function environmentUsedByOtherAccount(state, environmentId, accountId) {
  return state.accounts.some(other => other.id !== accountId
    && (other.browserEnvironmentId === environmentId
      || (other.binding && other.binding.environmentId === environmentId)));
}

function managedEnvironmentLabel(teacherName, platform, browserKind) {
  const suffix = ` · ${PLATFORM_LABELS[platform]} · ${browserKind === 'chrome' ? 'Chrome' : 'Edge'}`;
  return `${teacherName.slice(0, Math.max(0, 100 - suffix.length))}${suffix}`;
}

function assignBrowserEnvironment(store, accountId, browserKind) {
  assertStore(store);
  const id = requireId(accountId, '账号ID');
  if (!['chrome', 'msedge'].includes(browserKind)) fail('请选择Chrome或Edge。');
  let result;
  store.update(state => {
    ensureStateObject(state);
    const account = state.accounts.find(a => a.id === id);
    if (!account) fail('账号不存在，不能分配专属浏览器。');
    if (!MANAGED_BROWSER_PLATFORMS.has(account.platform)) {
      fail('此平台尚未接入专属浏览器。');
    }
    if (!account.teacherId) fail('请先为账号分配老师，再创建专属浏览器。');
    if (account.binding && account.binding.source !== 'managed_browser') fail('此账号仍绑定旧扩展，请先解除旧绑定再创建专属浏览器。');
    let environment = null;
    if (account.browserEnvironmentId) {
      environment = state.environments.find(e => e.id === account.browserEnvironmentId);
      if (!environment) fail('账号已记录的专属浏览器环境不存在，请核对数据，不会自动更换目录。');
      if (environment.source !== 'managed_browser') fail('账号的专属浏览器环境来源不一致。');
      if (environment.teacherId !== account.teacherId) fail('专属浏览器属于其他老师，不能使用。');
      if (environment.deviceId !== state.deviceId) fail('专属浏览器属于其他电脑。');
      if (environment.browserKind !== browserKind) fail('此账号已分配另一种浏览器，请使用原专属浏览器。');
      if (environment.platform !== undefined && environment.platform !== account.platform) {
        fail('专属浏览器平台与账号平台不一致，不能使用。');
      }
      if (environmentUsedByOtherAccount(state, environment.id, account.id)) {
        fail('该浏览器环境已被其他账号使用，不能复用或覆盖原会话。');
      }
    } else {
      const now = new Date().toISOString();
      const teacher = state.teachers.find(t => t.id === account.teacherId);
      // 每个账号单独创建环境，不复用同老师或其他账号的任何现有目录。
      environment = {
        id: randomUUID(),
        source: 'managed_browser',
        connectorInstanceId: null,
        browserKind,
        teacherId: account.teacherId,
        deviceId: state.deviceId,
        platform: account.platform,
        label: managedEnvironmentLabel(teacher.name, account.platform, browserKind),
        createdAt: now,
        lastSeenAt: now
      };
      state.environments.push(environment);
      account.browserEnvironmentId = environment.id;
    }
    result = projectEnvironment(environment);
  });
  return clone(result);
}

function bindBrowserAccount(store, input) {
  assertStore(store);
  if (!isPlainObject(input)) fail('绑定参数格式不正确。');
  const id = requireId(input.accountId, '账号ID');
  const environmentId = requireUuid(input.environmentId, '浏览器环境ID');
  const platformAccountId = requirePlatformAccountId(input.platformAccountId);
  const displayName = requireOptionalText(input.displayName, '显示名称', 120);
  let result;
  store.update(state => {
    ensureStateObject(state);
    const account = state.accounts.find(a => a.id === id);
    if (!account) fail('账号不存在，不能绑定。');
    if (!MANAGED_BROWSER_PLATFORMS.has(account.platform)) {
      fail('此平台尚未接入专属浏览器。');
    }
    if (!account.teacherId) fail('请先为账号分配老师，再绑定专属浏览器。');
    const env = state.environments.find(e => e.id === environmentId);
    if (!env || env.source !== 'managed_browser' || account.browserEnvironmentId !== environmentId
      || env.teacherId !== account.teacherId || env.deviceId !== state.deviceId) fail('专属浏览器与老师归属不一致。');
    if (env.platform !== undefined && env.platform !== account.platform) {
      fail('账号平台与专属浏览器环境平台不一致，不能绑定。');
    }
    if (environmentUsedByOtherAccount(state, env.id, account.id)) {
      fail('该浏览器环境已被其他账号使用，不能复用或覆盖原会话。');
    }
    if (account.binding) fail('账号已绑定，请核对原身份，不会覆盖绑定。');
    if (state.accounts.some(a => a.id !== id && a.binding && a.platform === account.platform
      && a.binding.platformAccountId === platformAccountId)) fail('真实账号已绑定其他老师或账号记录。');
    const now = new Date().toISOString();
    env.lastSeenAt = now;
    account.binding = { source: 'managed_browser', environmentId, connectorInstanceId: null,
      platformAccountId, displayName, verifiedAt: now, revision: randomUUID() };
    account.status = 'bound';
    result = projectAccount(account);
  });
  return clone(result);
}

function assertBrowserIdentity(store, input) {
  const data = snapshotAccounts(store);
  const account = data.accounts.find(a => a.id === input?.accountId);
  const env = data.environments.find(e => e.id === input?.environmentId);
  if (!account || !account.binding || account.binding.source !== 'managed_browser'
    || account.binding.environmentId !== env?.id || env?.source !== 'managed_browser'
    || env.deviceId !== data.deviceId || account.browserEnvironmentId !== env.id) fail('账号尚未绑定此本机专属浏览器。');
  if (account.teacherId === null || env.teacherId !== account.teacherId) {
    fail('账号老师与专属浏览器归属不一致，已停止此账号操作。');
  }
  if (env.platform !== undefined && env.platform !== account.platform) {
    fail('账号平台与专属浏览器环境平台不一致，已停止此账号操作。');
  }
  if (environmentUsedByOtherAccount(data, env.id, account.id)) fail('该专属环境已被其他账号引用，已停止此账号操作。');
  if (account.binding.platformAccountId !== input.platformAccountId) fail('真实账号不一致，已停止此账号操作。');
  return clone(account);
}

function snapshotAccounts(store) {
  assertStore(store);
  ensureAccountState(store);
  const state = store.load();
  return clone({
    teachers: state.teachers.map(projectTeacher),
    environments: state.environments.map(projectEnvironment),
    accounts: state.accounts.map(projectAccount),
    deviceId: state.deviceId
  });
}

module.exports = {
  PLATFORM_IDS,
  PLATFORM_LABELS,
  ensureAccountState,
  saveTeacher,
  saveTeacherProfile,
  saveManagedAccount,
  bindManagedAccount,
  unbindManagedAccount,
  assertIdentity,
  assignBrowserEnvironment,
  bindBrowserAccount,
  assertBrowserIdentity,
  snapshotAccounts
};
