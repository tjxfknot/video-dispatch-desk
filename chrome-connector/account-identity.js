(() => {
  'use strict';
  if (location.origin !== 'https://creator.douyin.com' || location.pathname !== '/creator-micro/home') return null;
  // Only rendered account labels on the creator homepage. No cookies, storage,
  // network responses, framework internals, or arbitrary script evaluation.
  const read = () => {
    if (location.origin !== 'https://creator.douyin.com' || location.pathname !== '/creator-micro/home') return null;
    const visible = String(document.body?.innerText || '').slice(0, 150_000);
    const values = [...visible.matchAll(/抖音(?:号|\s*ID)\s*[:：]?\s*([A-Za-z0-9_.-]{3,64})(?=\s|$)/gi)].map(m => m[1]);
    const unique = [...new Set(values)];
    if (unique.length !== 1) return null;
    return { pageOrigin: location.origin, pagePath: location.pathname, platformAccountId: unique[0], displayName: '', source: 'visible_account_label' };
  };
  const current = read();
  if (current) return Promise.resolve(current);
  return new Promise(resolve => {
    let timer;
    const finish = value => { clearTimeout(timer); observer.disconnect(); resolve(value); };
    const observer = new MutationObserver(() => { const result = read(); if (result) finish(result); });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    timer = setTimeout(() => finish(null), 12_000);
  });
})();
