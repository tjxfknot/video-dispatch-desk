'use strict';
// Only visible, explicitly labelled account identifiers are accepted. These
// conservative adapters need real sign-in acceptance; nicknames are never IDs.
const BROWSER_PLATFORMS = Object.freeze({
  douyin: Object.freeze({ label: '抖音', origin: 'https://creator.douyin.com', entry: 'https://creator.douyin.com/creator-micro/home', home: 'https://creator.douyin.com/creator-micro/home', identityPaths: ['/creator-micro/home'], idLabel: '抖音号', idPattern: /(?:^|\n)[ \t]*抖音(?:号|[ \t]*ID)\s*[:：]?\s*([A-Za-z0-9_.-]{3,64})(?=\s|$)/gi }),
  tencent: Object.freeze({ label: '视频号', origin: 'https://channels.weixin.qq.com', entry: 'https://channels.weixin.qq.com/login.html', home: 'https://channels.weixin.qq.com/platform', identityPaths: ['/platform', '/platform/home'], idLabel: '视频号ID', idPattern: /(?:^|\n)[ \t]*视频号[ \t]*ID\s*[:：]?\s*([A-Za-z0-9_.-]{3,64})(?=\s|$)/gi }),
  xiaohongshu: Object.freeze({ label: '小红书', origin: 'https://creator.xiaohongshu.com', entry: 'https://creator.xiaohongshu.com/login', home: 'https://creator.xiaohongshu.com/new/home', identityPaths: ['/home', '/new/home'], idLabel: '小红书号', idPattern: /(?:^|\n)[ \t]*小红书(?:号|[ \t]*ID)\s*[:：]?\s*([A-Za-z0-9_.-]{3,64})(?=\s|$)/gi })
});
function browserPlatform(platform = 'douyin') {
  if (!Object.hasOwn(BROWSER_PLATFORMS, platform)) throw new Error('此平台尚未接入专属浏览器。');
  return BROWSER_PLATFORMS[platform];
}
function allowedNavigation(value, platform = 'douyin') {
  try {
    const config = browserPlatform(platform), u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
    return platform === 'douyin' ? u.hostname === 'douyin.com' || u.hostname.endsWith('.douyin.com') : u.origin === config.origin;
  } catch { return false; }
}
function isIdentityPage(value, platform = 'douyin') {
  try { const u = new URL(value), c = browserPlatform(platform); return u.origin === c.origin && c.identityPaths.includes(u.pathname.replace(/\/$/, '')); } catch { return false; }
}
function isLoginPage(value, platform = 'douyin') {
  try { const u = new URL(value); return u.origin === browserPlatform(platform).origin && /\/(?:login|signin)(?:\.html)?\/?$/i.test(u.pathname); } catch { return false; }
}
function parseIdentity(url, text, platform = 'douyin', { profileHeader = false } = {}) {
  if (!isIdentityPage(url, platform)) return null;
  const config = browserPlatform(platform);
  // The real creator home can place nickname, ID and bio on one visual row.
  // Only loosen line boundaries for a separately identified own-profile header;
  // arbitrary body text must retain the original conservative parser.
  const pattern = platform === 'douyin' && profileHeader
    ? /抖音(?:号|[ \t]*ID)[ \t]*[:：][ \t]*([A-Za-z0-9_.-]{3,64})(?=[^A-Za-z0-9_.-]|$)/gi
    : new RegExp(config.idPattern);
  const ids = [...new Set([...String(text || '').slice(0, 150_000).matchAll(pattern)].map(m => m[1]))];
  return ids.length === 1 ? { platformAccountId: ids[0], displayName: '' } : null;
}
function observationFromPage({ url, text, loginVisible, profileHeaderText, authenticatedOwnIdentity }, platform = 'douyin') {
  const config = browserPlatform(platform);
  if (!allowedNavigation(url, platform)) return { identity: null, state: 'unverifiable', message: `当前不是允许的${config.label}官方页面。` };
  const hasHeader = platform === 'douyin' && typeof profileHeaderText === 'string' && !!profileHeaderText.trim();
  let identity = parseIdentity(url, hasHeader ? profileHeaderText : text, platform, { profileHeader: hasHeader });
  if (platform === 'xiaohongshu' && isIdentityPage(url,platform) && /^[a-f0-9]{24}$/i.test(authenticatedOwnIdentity?.platformAccountId || '')) {
    identity = authenticatedOwnIdentity;
  }
  const login = loginVisible === true || isLoginPage(url, platform);
  if ((login || !identity) && /登录.{0,6}频繁|频繁.{0,6}登录/.test(String(text || ''))) return { identity: null, state: 'error', message: '平台提示登录频繁，请停止重复尝试；工作台不会自动刷新或再次扫码。' };
  if (login) return { identity: null, state: 'awaiting_login', message: `请在${config.label}官方窗口自行登录；工作台不会代输验证码或代扫码。` };
  if (identity) return { identity, state: 'identified', message: authenticatedOwnIdentity ? '已从官方创作首页本次返回的当前用户信息读取账号标识。' : `程序已读取官方首页明确标示的${config.idLabel}。` };
  return { identity: null, state: 'checking', message: `请回到${config.label}官方首页，等待页面显示${config.idLabel}；只有昵称不能确认归属。` };
}
module.exports = { BROWSER_PLATFORMS, browserPlatform, allowedNavigation, isIdentityPage, isLoginPage, parseIdentity, observationFromPage };
