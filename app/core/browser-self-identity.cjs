'use strict';

// Read only the creator site's current-user information in its own document.
// Login stays inside the browser; no cookies or signed requests are exported.
const SELF_IDENTITY_SPECS = Object.freeze({
  xiaohongshu: Object.freeze({
    matchRequest(url, method) {
      return url.origin === 'https://creator.xiaohongshu.com'
        && url.pathname === '/api/galaxy/user/info'
        && method === 'GET';
    },
    parsePayload(payload) {
      const id = typeof payload?.data?.userId === 'string' ? payload.data.userId : '';
      const valid = payload?.success === true
        && (payload.code === undefined || payload.code === 0)
        && /^[a-f0-9]{24}$/i.test(id);
      return {
        success: payload?.success === true,
        data: payload?.data,
        hasUserId: typeof payload?.data?.userId === 'string',
        userIdFormatValid: /^[a-f0-9]{24}$/i.test(id),
        identity: valid ? {
          platformAccountId: id,
          displayName: typeof payload.data.userName === 'string' ? payload.data.userName.slice(0, 120) : ''
        } : null,
      };
    },
    fallbackFetch: async page => {
      await page.evaluate(async () => {
        if (location.origin !== 'https://creator.xiaohongshu.com' || !['/home', '/new/home'].includes(location.pathname.replace(/\/$/, ''))) return;
        const control = new AbortController(), timer = setTimeout(() => control.abort(), 5000);
        try { const r = await fetch('/api/galaxy/user/info', { credentials: 'same-origin', cache: 'no-store', signal: control.signal }); await r.arrayBuffer(); }
        finally { clearTimeout(timer); }
      });
    },
  }),
});

function observeSelfIdentity(context, platform, { now = Date.now } = {}) {
  const entries = new WeakMap();
  const spec = Object.hasOwn(SELF_IDENTITY_SPECS, platform) ? SELF_IDENTITY_SPECS[platform] : null;
  if (!spec) return () => null;
  const pending = new WeakMap(), generations = new WeakMap(), requests = new WeakMap(), attempted = new WeakSet(), evidence = new WeakMap();
  const invalidate = page => { generations.set(page, (generations.get(page) || 0) + 1); entries.delete(page); };
  context.on('request', request => {
    try {
      if (request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame()) {
        const page = request.frame().page(); invalidate(page); attempted.delete(page); pending.delete(page); evidence.delete(page);
      }
      const url = new URL(request.url());
      if (!spec.matchRequest(url, request.method()) || !['xhr', 'fetch'].includes(request.resourceType())) return;
      const frame = request.frame(), page = frame.page();
      if (frame !== page.mainFrame()) return;
      attempted.add(page); evidence.set(page, { requestSeen: true });
      invalidate(page);
      requests.set(request, { page, documentUrl: page.url(), generation: generations.get(page) });
    } catch { /* An unowned request cannot establish identity. */ }
  });
  context.on('response', response => {
    try {
      const request = response.request(), info = requests.get(request);
      if (!info) return;
      const { page, documentUrl, generation } = info;
      if (generations.get(page) !== generation) return;
      const work = (async () => {
        evidence.set(page, { requestSeen: true, httpStatus: response.status() });
        if (response.status() !== 200) return;
        const payload = await response.json();
        if (generations.get(page) !== generation) return;
        const parsed = spec.parsePayload(payload);
        evidence.set(page, {
          requestSeen: true,
          httpStatus: response.status(),
          success: parsed.success === true,
          dataFields: parsed.data && typeof parsed.data === 'object' ? Object.keys(parsed.data).filter(k => /^[A-Za-z_]{1,40}$/.test(k)).slice(0, 40) : [],
          hasUserId: parsed.hasUserId === true,
          userIdFormatValid: parsed.userIdFormatValid === true,
        });
        if (!parsed.identity) return;
        if (page.isClosed() || generations.get(page) !== generation) return;
        entries.set(page, { documentUrl, checkedAt: now(), identity: parsed.identity });
      })().catch(() => {});
      pending.set(page, work);
    } catch { /* A detached response cannot establish a current identity. */ }
  });
  return async page => {
    if (!attempted.has(page) && spec.fallbackFetch) {
      // Some creator home revisions do not fetch their own user information.
      // Read it once per document from the same origin, using that browser's
      // existing login. A failure is shown; it never initiates another QR flow.
      attempted.add(page);
      try { await spec.fallbackFetch(page); }
      catch { evidence.set(page, { requestSeen: false, requestFailed: true }); }
    }
    if (pending.has(page)) await pending.get(page);
    const value = entries.get(page);
    return value && now() - value.checkedAt < 300_000
      ? { ...value, evidence: evidence.get(page) } : { identity: null, evidence: evidence.get(page) || { requestSeen: false } };
  };
}
module.exports = { observeSelfIdentity, SELF_IDENTITY_SPECS };
