'use strict';

// A toast or a URL from another site is not a platform work receipt.
function workReference(value,platform='douyin') {
  try {
    const u=new URL(value);
    if(u.protocol!=='https:' || u.port || u.username || u.password)return null;
    let id;
    if(platform==='douyin' && /^(?:www\.)?douyin\.com$/.test(u.hostname))id=u.pathname.match(/^\/video\/(\d{10,30})\/?$/)?.[1];
    if(platform==='xiaohongshu' && u.hostname==='www.xiaohongshu.com')id=u.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/i)?.[1];
    if(platform==='tencent' && u.origin==='https://channels.weixin.qq.com' && u.pathname==='/platform/post/detail'){
      const value=u.searchParams.get('feedId');if(/^(?:export\/)?[A-Za-z0-9_-]{8,128}$/.test(value || ''))id=value;
    }
    if(!id)return null;
    return {workId:id,workUrl:platform==='douyin'?`https://www.douyin.com/video/${id}`:platform==='tencent'?`${u.origin}${u.pathname}?feedId=${encodeURIComponent(id)}`:`${u.origin}${u.pathname.replace(/\/$/,'')}`};
  } catch {return null;}
}
function managedReceipt(raw, settings = {}, platform='douyin') {
  if (!raw || raw.status !== 'submitted' || typeof raw.workId !== 'string') return null;
  const reference=workReference(raw.workUrl,platform);
  if(!reference || reference.workId!==raw.workId)return null;
  try {
    const url = new URL(raw.workUrl);
    if (url.protocol !== 'https:') return null;
  } catch { return null; }
  if (['self','public','friends'].includes(settings.visibility) && raw.visibility !== settings.visibility) return null;
  const result = { status: 'submitted', platform, ...reference };
  for (const key of ['message', 'verification', 'publishedAt', 'duration', 'platformStatus','visibilityVerification']) {
    if (typeof raw[key] === 'string') result[key] = Array.from(raw[key]).slice(0, key === 'message' ? 500 : 100).join('');
  }
  if (['self', 'friends', 'public', 'unverified'].includes(raw.visibility)) result.visibility = raw.visibility;
  try {
    const source = new URL(raw.sourceUrl);
    if (source.origin === 'https://creator.douyin.com' && source.pathname === '/creator-micro/content/post/video'
      && source.searchParams.get('mid') === raw.workId) {
      result.sourceUrl = `${source.origin}${source.pathname}?mid=${raw.workId}`;
    }
  } catch {}
  return result;
}

module.exports = { managedReceipt,workReference };
