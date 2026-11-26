'use strict';

const { parseAt } = require('./publish-schedule.cjs');

const WORK_LIST_ORIGIN = 'https://creator.douyin.com';
const WORK_LIST_PATH = '/janus/douyin/creator/pc/work_list';
const WORK_ID_RE = /^\d{10,30}$/;

function formatBeijingMinute(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const bj = new Date(ms + 8 * 3600_000);
  const pad = n => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}年${pad(bj.getUTCMonth() + 1)}月${pad(bj.getUTCDate())}日 ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
}

function formatDuration(raw, { isMilliseconds = false } = {}) {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return '';
  const seconds = isMilliseconds || num > 1_000 ? Math.round(num / 1000) : Math.round(num);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractWorkId(item) {
  // Real Douyin work_list returns exact 64-bit string in aweme_id / status.aweme_id,
  // while numeric item_id loses precision in IEEE-754 float64 (ending in ...000).
  const candidates = [
    item?.item_id_plain,
    item?.aweme_id,
    item?.status?.aweme_id,
    item?.item_id,
    item?.id,
  ];
  for (const val of candidates) {
    if (typeof val === 'string' && WORK_ID_RE.test(val.trim())) return val.trim();
    if (typeof val === 'number' && Number.isSafeInteger(val) && WORK_ID_RE.test(String(val))) return String(val);
  }
  return '';
}

function extractVisibility(item) {
  const candidates = [
    item?.status?.private_status,
    item?.private_status,
    item?.visibility_type,
    item?.visibility,
    item?.item_visibility,
  ];
  for (const val of candidates) {
    if (val === 0 || val === '0' || val === 'public') return 'public';
    if (val === 1 || val === '1' || val === 'private' || val === 'self') return 'self';
    if (val === 2 || val === '2' || val === 'friends' || val === 'friend') return 'friends';
  }
  if (item?.status?.is_private === true || item?.is_private === true) return 'self';
  const desc = [item?.visibility_desc, item?.status_desc, item?.status_text].filter(v => typeof v === 'string').join(' ');
  if (/私密|仅自己可见|仅我可见/.test(desc)) return 'self';
  if (/好友可见|互关朋友可见/.test(desc)) return 'friends';
  return 'unverified';
}

function extractScheduledTimeMs(item) {
  const raw = item?.timer?.public_time;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return NaN;
  return num > 1e12 ? num : num * 1000;
}

function extractPlatformStatus(item) {
  const text = [item?.status_desc, item?.status_text, item?.item_status_desc, item?.audit_status_desc]
    .filter(v => typeof v === 'string')
    .join(' ');
  if (/审核未通过|未通过审核|不适宜公开/.test(text) || item?.status?.is_prohibited === true) return 'rejected';
  // 2026-11-21 实测抖音定时作品：work_list 返回 timer: { public_time: <unix_sec>, status: 0 }，
  // 立即发布作品不含 timer 字段。
  const scheduledTimeMs = extractScheduledTimeMs(item);
  if (/定时发布/.test(text) || (Number.isFinite(scheduledTimeMs) && (item?.timer?.status === 0 || item?.timer?.status === undefined))) {
    return 'scheduled';
  }
  if (/审核中|转码中|处理中/.test(text) || item?.status?.in_reviewing === true || item?.in_reviewing === true) return 'under_review';
  if (/已发布|发布成功/.test(text)) return 'published';
  if (item?.status?.is_delete === false && item?.status?.in_reviewing === false && item?.status?.is_prohibited === false) {
    // 2026-11-21 live logged-in work_list evidence:
    // status_value 102 = public published, 140/141 = private published (reviewed is boolean false).
    if ([102, 140, 141].includes(item?.status_value) || item?.status?.reviewed === 1 || item?.status?.reviewed === true) {
      return 'published';
    }
  }
  return 'unknown';
}

function extractCreateTimeMs(item) {
  const raw = item?.create_time ?? item?.publish_time ?? item?.create_timestamp;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return NaN;
  return num > 1e12 ? num : num * 1000;
}

function parseDouyinWorkListResponse(payload) {
  if (!payload || typeof payload !== 'object') return { items: [], schema: null };
  const rawList = Array.isArray(payload.aweme_list)
    ? payload.aweme_list
    : Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.item_info_list)
        ? payload.item_info_list
        : Array.isArray(payload.data?.aweme_list)
          ? payload.data.aweme_list
          : Array.isArray(payload.data?.items)
            ? payload.data.items
            : null;
  if (!rawList) return { items: [], schema: null };

  const items = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const workId = extractWorkId(raw);
    const title = normalizeTitle(raw.title || raw.item_title || raw.desc || raw.description || '');
    const createTimeMs = extractCreateTimeMs(raw);
    const scheduledTimeMs = extractScheduledTimeMs(raw);
    const duration = raw.video?.duration !== undefined
      ? formatDuration(raw.video.duration, { isMilliseconds: true })
      : formatDuration(raw.duration ?? raw.video_duration);
    const visibility = extractVisibility(raw);
    const platformStatus = extractPlatformStatus(raw);
    items.push({
      workId,
      title,
      createTimeMs,
      scheduledTimeMs,
      publishedAt: formatBeijingMinute(Number.isFinite(scheduledTimeMs) ? scheduledTimeMs : createTimeMs),
      duration,
      visibility,
      platformStatus,
    });
  }

  const first = rawList[0] && typeof rawList[0] === 'object' ? rawList[0] : null;
  const schema = {
    statusCode: payload.status_code ?? null,
    count: rawList.length,
    topKeys: Object.keys(payload).filter(k => /^[A-Za-z0-9_]{1,40}$/.test(k)).slice(0, 25),
    itemKeys: first ? Object.keys(first).filter(k => /^[A-Za-z0-9_]{1,40}$/.test(k)).slice(0, 45) : [],
    statusKeys: first?.status && typeof first.status === 'object'
      ? Object.keys(first.status).filter(k => /^[A-Za-z0-9_]{1,40}$/.test(k)).slice(0, 30)
      : [],
  };
  return { items, schema };
}

function matchDouyinWorkListItem(items, job = {}) {
  if (!Array.isArray(items) || !items.length) return { status: 'none', item: null, count: 0 };
  const expectedTitle = normalizeTitle(job.copy?.title || '');
  const expectedId = typeof job.expectedWorkId === 'string' && WORK_ID_RE.test(job.expectedWorkId) ? job.expectedWorkId : '';
  const startedMs = job.runCreatedAt ? Date.parse(job.runCreatedAt) : NaN;
  const minTimeMs = Number.isFinite(startedMs) ? Math.floor(startedMs / 60_000) * 60_000 : NaN;

  if (expectedId) {
    const byId = items.filter(it => it.workId === expectedId);
    if (byId.length === 1) {
      const it = byId[0];
      if (!expectedTitle || !it.title || it.title === expectedTitle || it.title.includes(expectedTitle)) {
        return { status: 'matched', item: it, count: 1 };
      }
      return { status: 'conflict', item: it, count: 1 };
    }
  }

  if (!expectedTitle) return { status: 'none', item: null, count: 0 };
  const expectedScheduleMs = job.schedule?.mode === 'scheduled' ? parseAt(job.schedule.at)?.getTime() : NaN;
  const byTitle = items.filter(it => {
    if (!it.workId) return false;
    if (it.title !== expectedTitle) return false;
    if (!expectedId && job.schedule?.mode === 'scheduled') {
      if (it.platformStatus !== 'scheduled') return false;
      const actualScheduleMs = Number.isFinite(it.scheduledTimeMs) ? it.scheduledTimeMs : it.createTimeMs;
      if (!Number.isFinite(expectedScheduleMs) || !Number.isFinite(actualScheduleMs)) return false;
      if (Math.floor(actualScheduleMs / 60_000) !== Math.floor(expectedScheduleMs / 60_000)) return false;
    }
    if (!expectedId && Number.isFinite(minTimeMs)) {
      if (!Number.isFinite(it.createTimeMs) || it.createTimeMs < minTimeMs) return false;
    }
    return true;
  });

  const unique = [...new Map(byTitle.map(it => [it.workId, it])).values()];
  if (unique.length === 0) return { status: 'none', item: null, count: 0 };
  if (unique.length > 1) return { status: 'ambiguous', item: null, count: unique.length };
  if (expectedId && unique[0].workId !== expectedId) {
    return { status: 'conflict', item: unique[0], count: 1 };
  }
  return { status: 'matched', item: unique[0], count: 1 };
}

// Read-only passive observer for Douyin's own manage work_list JSON responses.
// Never sends extra requests, never reads cookies or signed media URLs.
// Real manage page issues multiple work_list calls (including a 1-item query);
// merge items by workId so a small secondary call never wipes the main list.
function observeDouyinWorkList(page) {
  const byWorkId = new Map();
  let latest = { items: [], schema: null, capturedAt: 0, responseCount: 0 };
  const pending = new Set();

  const onResponse = response => {
    try {
      const u = new URL(response.url());
      if (u.origin !== WORK_LIST_ORIGIN || u.pathname !== WORK_LIST_PATH) return;
      if (response.status() !== 200) return;
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      if (ct && !ct.includes('json')) return;
      const task = response.json()
        .then(payload => {
          const parsed = parseDouyinWorkListResponse(payload);
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
      // Ignore malformed or detached responses.
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

// Parse Douyin's right-panel "快速检测 / 封面优化建议" advisory state.
// Never fails hard when the widget is absent (platform layout may evolve).
function parsePlatformQuickCheck(text, job = {}) {
  const raw = String(text || '');
  const hasWidget = /快速检测|封面效果检测通过|封面检测通过|封面检测中|封面优化建议/.test(raw);
  if (!hasWidget) {
    return { present: false, state: 'not_present', percent: null, issues: [], summary: '', requiresConfirmation: false };
  }

  const pctMatch = raw.match(/检测中\s*(\d{1,3})\s*%/);
  const isChecking = !!pctMatch || /封面检测中/.test(raw);
  const isPassed = /封面效果检测通过|封面检测通过|暂未发现封面低质问题/.test(raw);

  if (isChecking && !isPassed) {
    const percent = pctMatch ? Number(pctMatch[1]) : null;
    return {
      present: true,
      state: 'checking',
      percent,
      issues: [],
      summary: percent !== null ? `平台快速检测尚未完成（${percent}%）` : '平台快速检测尚未完成',
      requiresConfirmation: true,
    };
  }

  if (isPassed) {
    return {
      present: true,
      state: 'passed',
      percent: 100,
      issues: [],
      summary: '平台封面快速检测通过',
      requiresConfirmation: false,
    };
  }

  const issues = [];
  const hasLandscape = !!(job?.files?.landscape && job?.coverMode !== 'video_default');
  const hasPortrait = !!(job?.files?.portrait && job?.coverMode !== 'video_default');
  if (hasLandscape && /横封面缺失/.test(raw)) issues.push('横封面缺失（与本任务已上传横封面矛盾）');
  if (hasPortrait && /竖封面缺失/.test(raw)) issues.push('竖封面缺失（与本任务已上传竖封面矛盾）');
  if (/封面低质|封面模糊|画面黑屏/.test(raw) && !/暂未发现封面低质问题/.test(raw)) {
    issues.push('平台提示封面质量异常');
  }

  if (issues.length > 0) {
    return {
      present: true,
      state: 'advisory',
      percent: 100,
      issues,
      summary: issues.join('；'),
      requiresConfirmation: true,
    };
  }

  return {
    present: true,
    state: 'passed',
    percent: 100,
    issues: [],
    summary: '未发现与本任务矛盾的平台检测提示',
    requiresConfirmation: false,
  };
}

module.exports = {
  WORK_LIST_ORIGIN,
  WORK_LIST_PATH,
  parseDouyinWorkListResponse,
  matchDouyinWorkListItem,
  observeDouyinWorkList,
  parsePlatformQuickCheck,
};
