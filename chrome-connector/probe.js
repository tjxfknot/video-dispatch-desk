(() => {
  'use strict';

  const pageOrigin = location.origin;
  const pagePath = location.pathname.split(/[?#]/, 1)[0] || '/';
  const visible = element => {
    if (!element || !element.getClientRects().length) return false;
    for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    }
    return true;
  };

  // Read only short labels from visible controls and headings. Never inspect
  // page-wide text, content cards, images, inputs, or form values.
  const labels = [...document.querySelectorAll('button,label,[role="button"],h1,h2,h3,h4,a')]
    .filter(visible)
    .map(element => (element.innerText || '').replace(/\s+/g, ' ').trim())
    .filter(text => text.length > 0 && text.length <= 120);

  const hasExactOrLabel = terms => labels.some(label => terms.some(term =>
    label === term || label.startsWith(`${term} `)));
  // Login widgets often use plain spans. Match their exact short labels only;
  // do not inspect QR images or any login input.
  const loginTerms = ['扫码登录', '手机号登录', '手机登录', '二维码失效', '二维码已失效'];
  const loginVisible = hasExactOrLabel(loginTerms) || [...document.querySelectorAll('span')]
    .some(element => visible(element) && loginTerms.includes((element.innerText || '').trim()));
  const workspaceDetected = hasExactOrLabel(['作品管理', '内容管理', '数据中心', '发布视频']);
  const has = pattern => labels.some(label => pattern.test(label));

  return {
    pageOrigin,
    pagePath,
    loginVisible,
    workspaceDetected,
    fields: {
      landscape: has(/横版封面|横封面/),
      portrait: has(/竖版封面|竖封面/),
      tags: has(/添加话题|输入标签|添加标签|话题/),
      declaration: has(/内容声明|作品声明|自主声明|个人观点|个人意见/),
      collection: has(/合集/)
    }
  };
})()
