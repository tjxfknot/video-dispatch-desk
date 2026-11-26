'use strict';

const { parseAt } = require('./publish-schedule.cjs');

const NOTE_LIST_ORIGIN = 'https://creator.xiaohongshu.com';
const NOTE_LIST_PATH_RE = /^\/api\/galaxy\/v2\/creator\/note\/user\/posted$/;
const WORK_ID_RE = /^[a-f0-9]{24}$/i;

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

function parseBeijingTimeMs(rawTime, fallbackUnixSec) {
  if (typeof rawTime === 'string') {
    const m = rawTime.trim().match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T${m[4]}:${m[5]}:${m[6] || '00'}+08:00`;
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) return ms;
    }
  }
  const num = Number(fallbackUnixSec);
  if (Number.isFinite(num) && num > 0) return num > 1e12 ? num : num * 1000;
  return NaN;
}

function extractVisibility(raw) {
  const msg = normalizeText(raw?.permission_msg || '');
  if (raw?.permission_code === 1 || /仅自己可见/.test(msg)) return 'self';
  if (/互关好友|好友可见/.test(msg)) return 'friends';
  if (raw?.permission_code === 0 && !msg) return 'public';
  return 'unverified';
}

function extractPlatformStatus(raw) {
  if (Number(raw?.schedule_post_time) > 0) return 'scheduled';
  if (raw?.tab_status === 1) return 'published';
  if (raw?.tab_status === 2) return 'under_review';
  if (raw?.tab_status === 3 || raw?.tab_status === 4) return 'rejected';
  return 'unknown';
}

function parseXiaohongshuNoteListResponse(payload) {
  if (!payload || typeof payload !== 'object') return { items: [], schema: null };
  if (payload.success === false) return { items: [], schema: null };
  if (payload.code !== undefined && payload.code !== 0) return { items: [], schema: null };
  const rawList = Array.isArray(payload.data?.notes) ? payload.data.notes : null;
  if (!rawList) return { items: [], schema: null };

  const items = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const rawId = typeof raw.id === 'string' ? raw.id.trim() : typeof raw.note_id === 'string' ? raw.note_id.trim() : '';
    const workId = WORK_ID_RE.test(rawId) ? rawId.toLowerCase() : '';
    const title = normalizeText(raw.display_title || raw.title || '');
    const createTimeMs = parseBeijingTimeMs(raw.time, raw.visible_time);
    const scheduledTimeMs = parseBeijingTimeMs('', raw.schedule_post_time);
    const duration = formatDurationSeconds(raw.video_info?.duration ?? raw.duration);
    const platformStatus = extractPlatformStatus(raw);
    items.push({
      workId,
      title,
      type: typeof raw.type === 'string' ? raw.type : '',
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
    code: payload.code ?? null,
    count: rawList.length,
    page: Number.isFinite(Number(payload.data?.page)) ? Number(payload.data.page) : null,
    itemKeys: first ? Object.keys(first).filter(k => /^[A-Za-z0-9_]{1,40}$/.test(k)).slice(0, 40) : [],
  };
  return { items, schema };
}

function matchesXiaohongshuTitle(item, job) {
  const expectedTitle = normalizeText(job.copy?.title || '');
  if (!expectedTitle) return false;
  return item.title === expectedTitle;
}

function matchXiaohongshuNoteItem(items, job = {}) {
  if (!Array.isArray(items) || !items.length) return { status: 'none', item: null, count: 0 };
  const expectedId = typeof job.expectedWorkId === 'string' && WORK_ID_RE.test(job.expectedWorkId)
    ? job.expectedWorkId.toLowerCase()
    : '';
  const startedMs = job.runCreatedAt ? Date.parse(job.runCreatedAt) : NaN;
  const minTimeMs = Number.isFinite(startedMs) ? Math.floor(startedMs / 60_000) * 60_000 : NaN;

  if (expectedId) {
    const byId = items.filter(it => it.workId === expectedId);
    if (byId.length === 1) {
      const it = byId[0];
      if (!normalizeText(job.copy?.title) || matchesXiaohongshuTitle(it, job)) {
        return { status: 'matched', item: it, count: 1 };
      }
      return { status: 'conflict', item: it, count: 1 };
    }
  }

  const isScheduledJob = job.schedule?.mode === 'scheduled';
  const expectedSchedDate = isScheduledJob ? parseAt(job.schedule?.at) : null;
  const expectedSchedMin = expectedSchedDate ? Math.floor(expectedSchedDate.getTime() / 60_000) : NaN;

  const matched = items.filter(it => {
    if (!it.workId) return false;
    if (!matchesXiaohongshuTitle(it, job)) return false;
    if (isScheduledJob) {
      if (it.platformStatus !== 'scheduled') return false;
      if (Number.isFinite(expectedSchedMin) && Number.isFinite(it.scheduledTimeMs)) {
        if (Math.floor(it.scheduledTimeMs / 60_000) !== expectedSchedMin) return false;
      } else if (Number.isFinite(expectedSchedMin)) {
        return false;
      }
      return true;
    }
    if (!expectedId && Number.isFinite(minTimeMs)) {
      if (!Number.isFinite(it.createTimeMs) || it.createTimeMs < minTimeMs) return false;
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

// Read-only passive observer for Xiaohongshu creator note-manager list API.
// Never issues extra requests, never reads cookies, xsec_token, or image URLs.
function observeXiaohongshuNoteList(page) {
  const byWorkId = new Map();
  let latest = { items: [], schema: null, capturedAt: 0, responseCount: 0 };
  const pending = new Set();

  const onResponse = response => {
    try {
      const u = new URL(response.url());
      if (u.origin !== NOTE_LIST_ORIGIN || !NOTE_LIST_PATH_RE.test(u.pathname)) return;
      if (response.status() !== 200) return;
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      if (ct && !ct.includes('json')) return;
      const task = response.json()
        .then(payload => {
          const parsed = parseXiaohongshuNoteListResponse(payload);
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
  NOTE_LIST_ORIGIN,
  NOTE_LIST_PATH_RE,
  parseXiaohongshuNoteListResponse,
  matchXiaohongshuNoteItem,
  observeXiaohongshuNoteList,
};
