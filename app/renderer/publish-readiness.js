'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PublishReadiness = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const result = (key, label, message, tone = 'warning', blocked = true) => ({ key, label, message, tone, blocked });
  function accountState(account, data = {}, now = Date.now()) {
    if (!account) return result('not_selected', '未选择账号', '请明确选择当前老师的本平台账号。');
    const session = data.browserSessions?.[account.id] || {};
    const check = data.accountChecks?.[account.id] || {};
    const binding = account.binding;
    if (!binding?.platformAccountId) {
      if (session.state === 'awaiting_confirmation' && session.candidate) return result('awaiting_confirmation', '待确认绑定', '已识别到账号，请核对真实号并确认绑定。');
      if (['opening', 'checking'].includes(session.state)) return result('checking', '未绑定 · 正在识别', '请在官方窗口完成登录，等待识别真实账号。', 'neutral');
      if (['awaiting_login', 'login_required'].includes(session.state)) return result('unbound', '未绑定 · 等待扫码', '请在官方窗口完成登录；程序识别并复核账号后会自动保存连接。');
      if (session.windowOpen && ['unverifiable', 'error'].includes(session.state)) return result('identity_unavailable', '未绑定 · 身份未识别', session.message || '官方页面尚未识别到唯一账号标识。已登录时请重新识别，不必反复扫码。');
      return result('unbound', '未绑定', '请点击连接账号；已有登录保留，识别并复核后会自动保存到当前老师。');
    }
    if (binding.source !== 'managed_browser') return result('unsupported', '需连接专属浏览器', '原连接方式不能执行当前发布，请在账号页处理连接。');
    const env = (data.environments || []).find(e => e.id === binding.environmentId);
    // 旧版专属环境没有platform字段。只有同老师且仍被本账号独占时兼容；
    // 不补写绑定或登录成功，真实身份仍由执行器在上传/提交前核对。
    const listedAccount = (data.accounts || []).some(a => a.id === account.id);
    const sharedEnvironment = !!env && (data.accounts || []).some(a => a.id !== account.id
      && (a.browserEnvironmentId === env.id || a.binding?.environmentId === env.id));
    if (account.status !== 'bound' || !binding.revision || !env || env.source !== 'managed_browser'
      || env.teacherId !== account.teacherId || (env.platform !== undefined && env.platform !== account.platform)
      || (env.platform === undefined && !listedAccount) || sharedEnvironment || account.browserEnvironmentId !== env.id) {
      return result('invalid_binding', '绑定信息需处理', '绑定与老师或专属浏览器不一致，请到账号页核对，不能借用其他账号。', 'danger');
    }
    if (check.pending || ['opening', 'checking'].includes(session.state)) return result('checking', '已绑定 · 正在检查', '正在读取当前登录身份；同一账号只执行一次检查。', 'neutral');
    const liveState = session.windowOpen && ['verified', 'bound', 'login_required', 'awaiting_login', 'mismatch', 'unverifiable', 'error'].includes(session.state) ? session.state : check.state;
    if (['login_required', 'awaiting_login'].includes(liveState)) return result('login_required', '已绑定 · 需要重新扫码', '平台已显示登录页，请在原专属窗口重新扫码；原绑定保留，不会反复打开登录页。', 'danger');
    if (liveState === 'mismatch') return result('mismatch', '已绑定 · 登录账号不一致', '当前登录号与绑定号不同，请核对原账号后再发布。原绑定保留。', 'danger');
    if (['unverifiable', 'error'].includes(liveState)) return result('unverifiable', '已绑定 · 本次核验未通过', session.message || check.message || '本次无法读取账号标识，检查已停止；原绑定保留，可在原窗口核对后手动重试。');
    const checkedAt = Date.parse(session.checkedAt || check.checkedAt || '');
    if (session.windowOpen && ['verified', 'bound'].includes(liveState) && Number.isFinite(checkedAt) && now - checkedAt < 300000 && checkedAt <= now + 5000) {
      return { ...result('verified', '已绑定 · 刚核对一致', '当前登录身份与绑定一致；上传和提交前程序仍会再核对。', 'success', false), checkedAt };
    }
    // 窗口仍开着且上次核对一致，只是过了5分钟：如实显示核对时间，
    // 不降级成“待检查”。是否仍有效由上传和提交前的自动复查决定。
    if (session.windowOpen && ['verified', 'bound'].includes(liveState) && Number.isFinite(checkedAt) && checkedAt <= now + 5000) {
      const minutes = Math.max(5, Math.floor((now - checkedAt) / 60000));
      const ago = minutes >= 120 ? `${Math.floor(minutes / 60)}小时前` : `${minutes}分钟前`;
      return { ...result('verified_earlier', `已绑定 · ${ago}核对一致`, '专属窗口仍开着，上次核对与绑定一致。无需手动检查；上传和提交前程序会自动再核对。', 'success', false), checkedAt };
    }
    return result('bound_unchecked', '已绑定 · 登录待检查', '尚未检查本次登录，不能认定已过期。可提前检查；执行时也会重新核对。', 'neutral', false);
  }
  function platformState(platform, data = {}, now = Date.now()) {
    const draft = data.currentDraft || {};
    const target = (draft.targets || []).find(t => t.platform === platform.id) || { platform: platform.id, enabled: false, accountId: '' };
    const teacher = (data.teachers || []).find(t => t.id === draft.teacherId);
    const accounts = teacher ? (data.accounts || []).filter(a => a.teacherId === teacher.id && a.platform === platform.id) : [];
    const account = accounts.find(a => a.id === target.accountId);
    let status;
    if (!teacher) status = result('no_teacher', '先选择老师', '选择任务归属老师后，才能查看该老师的平台账号。', 'neutral');
    else if (!accounts.length) status = result('no_account', '尚未添加账号', '这位老师还没有本平台账号，请先添加账号并扫码绑定。');
    else if (!account) {
      const states = accounts.map(a => accountState(a, data, now));
      const bound = accounts.filter(a => !!a.binding?.platformAccountId).length;
      const details = accounts.length === 1 ? states[0].label : `${bound}个已绑定，${accounts.length - bound}个未绑定`;
      status = result('not_selected', `未选择账号 · ${details}`, `请从下方选择账号。${accounts.length === 1 ? states[0].message : details + '。'}`);
    } else status = accountState(account, data, now);
    return { ...status, platform: platform.id, platformLabel: platform.label, target, account, accounts };
  }
  function summary(data = {}, now = Date.now()) {
    const rows = (data.platforms || []).map(p => platformState(p, data, now));
    const selected = rows.filter(r => r.target.enabled), blockers = selected.filter(r => r.blocked);
    return { rows, selected, blockers, ready: selected.length > 0 && blockers.length === 0 };
  }
  return Object.freeze({ accountState, platformState, summary });
});
