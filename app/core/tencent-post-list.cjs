'use strict';

const { parseAt } = require('./publish-schedule.cjs');

const POST_LIST_ORIGIN = 'https://channels.weixin.qq.com';
const POST_LIST_PATH_RE = /^\/(?:micro\/content\/)?cgi-bin\/mmfinderassistant-bin\/post\/post_list$/;
const WORK_ID_RE = /^(?:export\/)?[A-Za-z0-9_-]{8,128}$/;

function normalizeText(value) {
  return String(value || '').replace(/[\u200b\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatBeijingMinute(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const bj = new Date(ms + 8 * 3600_000);
  const pad = n => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}年${pad(bj.getUTCMonth() + 1)}月${pad(bj.getUTCDate())}日 ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
}

function formatDurationSeconds(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return '';
  const seconds = Math.round(num);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function extractWorkId(item) {
  const candidates = [item?.exportId, item?.objectId, item?.feedId];
  for (const val of candidates) {
    if (typeof val === 'string' && WORK_ID_RE.test(val.trim())) return val.trim();
  }
  return '';
}

function extractShortTitle(item) {
  const st = item?.desc?.shortTitle;
  if (Array.isArray(st) && st.length > 0) {
    const first = st[0];
    if (typeof first === 'string') return normalizeText(first);
    if (first && typeof first === 'object') return normalizeText(first.shortTitle || first.title || '');
  }
  if (typeof st === 'string') return normalizeText(st);
  return '';
}

function extractCreateTimeMs(item) {
  const raw = item?.createTime ?? item?.publishTime ?? item?.postTime;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return NaN;
  return num > 1e12 ? num : num * 1000;
}

function extractScheduledTimeMs(item) {
  const raw = item?.effectiveTime;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return NaN;
  return num > 1e12 ? num : num * 1000;
}

function extractVisibility(item) {
  // 2026-11-21 live post_list evidence: visibleType 1 = public/normal feed.
  if (item?.visibleType === 1) return 'public';
  return 'unverified';
}

function extractPlatformStatus(item) {
  if (item?.disableInfo?.isDisabled === true) return 'rejected';
  // 2026-11-22 live scheduled post_list evidence:
  // scheduled posts carry effectiveTime (unix sec) and handleStatus: 2; immediate posts omit both.
  const scheduledTimeMs = extractScheduledTimeMs(item);
  if (Number.isFinite(scheduledTimeMs) && (item?.handleStatus === 2 || scheduledTimeMs > Date.now())) {
    return 'scheduled';
  }
  if (item?.status === 1) return 'published';
  if (item?.status === 0) return 'under_review';
  return 'unknown';
}

function parseTencentPostListResponse(payload) {
  if (!payload || typeof payload !== 'object') return { items: [], schema: null };
  const errCode = payload.errCode ?? payload.errcode;
  if (errCode !== undefined && errCode !== 0) return { items: [], schema: null };
  const rawList = Array.isArray(payload.data?.list) ? payload.data.list : null;
  if (!rawList) return { items: [], schema: null };

  const items = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const workId = extractWorkId(raw);
    const description = normalizeText(raw.desc?.description || raw.description || '');
    const shortTitle = extractShortTitle(raw);
    const createTimeMs = extractCreateTimeMs(raw);
    const scheduledTimeMs = extractScheduledTimeMs(raw);
    const media0 = Array.isArray(raw.desc?.media) ? raw.desc.media[0] : null;
    const duration = formatDurationSeconds(media0?.videoPlayLen ?? raw.videoPlayLen);
    const platformStatus = extractPlatformStatus(raw);
    items.push({
      workId,
      shortTitle,
      description,
      createTimeMs,
      scheduledTimeMs,
      publishedAt: formatBeijingMinute(Number.isFinite(scheduledTimeMs) ? scheduledTimeMs : createTimeMs),
      duration,
      visibility: extractVisibility(raw),
      platformStatus,
    });
  }

  const first = rawList[0] && typeof rawList[0] === 'object' ? rawList[0] : null;
  const schema = {
    errCode: errCode ?? null,
    count: rawList.length,
    totalCount: Number.isFinite(Number(payload.data?.totalCount)) ? Number(payload.data.totalCount) : null,
    itemKeys: first ? Object.keys(first).filter(k => /^[A-Za-z0-9_]{1,40}$/.test(k)).slice(0, 40) : [],
  };
  return { items, schema };
}

function matchesTencentContent(item, job) {
  const expectedTitle = normalizeText(job.copy?.title || '');
  const expectedDesc = normalizeText(job.copy?.description || '');
  if (!expectedTitle) return false;
  if (item.shortTitle && item.shortTitle === expectedTitle) return true;
  if (item.description && item.description.includes(expectedTitle)) {
    if (!expectedDesc || item.description.includes(expectedDesc)) return true;
  }
  return false;
}

function matchTencentPostListItem(items, job = {}) {
  if (!Array.isArray(items) || !items.length) return { status: 'none', item: null, count: 0 };
  const expectedId = typeof job.expectedWorkId === 'string' && WORK_ID_RE.test(job.expectedWorkId) ? job.expectedWorkId : '';
  const startedMs = job.runCreatedAt ? Date.parse(job.runCreatedAt) : NaN;
  const minTimeMs = Number.isFinite(startedMs) ? Math.floor(startedMs / 60_000) * 60_000 : NaN;

  if (expectedId) {
    const byId = items.filter(it => it.workId === expectedId);
    if (byId.length === 1) {
      const it = byId[0];
      if (!normalizeText(job.copy?.title) || matchesTencentContent(it, job)) {
        return { status: 'matched', item: it, count: 1 };
      }
      return { status: 'conflict', item: it, count: 1 };
    }
  }

  const expectedScheduled = job.schedule?.mode === 'scheduled' ? parseAt(job.schedule.at) : null;
  const matched = items.filter(it => {
    if (!it.workId) return false;
    if (!matchesTencentContent(it, job)) return false;
    if (!expectedId && Number.isFinite(minTimeMs)) {
      if (!Number.isFinite(it.createTimeMs) || it.createTimeMs < minTimeMs) return false;
    }
    if (!expectedId && job.schedule?.mode === 'scheduled') {
      if (!expectedScheduled || !Number.isFinite(it.scheduledTimeMs) || it.platformStatus !== 'scheduled') return false;
      if (Math.floor(it.scheduledTimeMs / 60_000) !== Math.floor(expectedScheduled.getTime() / 60_000)) return false;
    } else if (!expectedId && job.schedule?.mode === 'immediate' && it.platformStatus === 'scheduled') {
      return false;
    }
    return true;
  });

  const unique = [...new Map(matched.map(it => [it.workId, it])).values()];
  if (unique.length === 0) return { status: 'none', item: null, count: 0 };
  if (unique.length > 1) return { status: 'ambiguous', item: null, count: unique.length };
  if (expectedId && unique[0].workId !== expectedId) {
    return { status: 'conflict', item: unique[0], count: 1 };
  }
  return { status: 'matched', item: unique[0], count: 1 };
}

// Read-only passive observer for Video Channel's own post_list JSON responses.
// Note: WeChat Channels returns HTTP 201 (not 200) for cgi-bin JSON POSTs.
// Never issues extra requests, never reads cookies or signed media URLs.
function observeTencentPostList(page) {
  const byWorkId = new Map();
  let latest = { items: [], schema: null, capturedAt: 0, responseCount: 0 };
  const pending = new Set();

  const onResponse = response => {
    try {
      const u = new URL(response.url());
      if (u.origin !== POST_LIST_ORIGIN || !POST_LIST_PATH_RE.test(u.pathname)) return;
      if (response.status() !== 200 && response.status() !== 201) return;
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      if (ct && !ct.includes('json')) return;
      const task = response.json()
        .then(payload => {
          const parsed = parseTencentPostListResponse(payload);
          if (parsed.schema) {
            for (const item of parsed.items) {
              if (item.workId) byWorkId.set(item.workId, item);
            }
            const merged = [...byWorkId.values()];
            latest = {
              items: merged.length ? merged : parsed.items,
              schema: parsed.schema.count >= (latest.schema?.count || 0) ? parsed.schema : latest.schema,
              capturedAt: Date.now(),
              responseCount: latest.responseCount + 1,
            };
          }
        })
        .catch(() => {})
        .finally(() => pending.delete(task));
      pending.add(task);
    } catch {
      // Ignore detached or non-JSON responses.
    }
  };

  page.on('response', onResponse);
  return {
    async flush() {
      if (pending.size) await Promise.all([...pending]);
      return latest;
    },
    snapshot() {
      return latest;
    },
    detach() {
      try { page.off('response', onResponse); } catch {}
    },
  };
}

module.exports = {
  POST_LIST_ORIGIN,
  POST_LIST_PATH_RE,
  parseTencentPostListResponse,
  matchTencentPostListItem,
  observeTencentPostList,
};
