(function (global) {
'use strict';

// 各平台“定时发布”的可选范围与接通状态。界面和任务构建共用这一份。
//
// 规则：没有真实页面依据的范围一律不填数字，写 known:false。
// 抖音：2 小时后～14 天内；视频号：5 分钟后～30 天内；小红书：1 小时后～14 天内。
const LABELS = Object.freeze({ douyin: '抖音', tencent: '视频号', xiaohongshu: '小红书' });
const LIMITS = Object.freeze({
  douyin: Object.freeze({ supported: true, known: true, minMinutes: 120, maxDays: 14, evidence: '真实发布页提示“2小时后及14天内”' }),
  tencent: Object.freeze({ supported: true, known: true, minMinutes: 5, maxDays: 30, evidence: '真实发布页选择器最晚至30天后同分钟，严格提交前留5分钟余量' }),
  xiaohongshu: Object.freeze({ supported: true, known: true, minMinutes: 60, maxDays: 14, evidence: '真实发布页提示“定时发布采用北京时间，支持选择未来 1 小时～14 天内的任意时间”' })
});
// 总览时多留的时间：视频上传和填写要花时间，等真正填到平台页面时仍须满足平台的最早时间。
const PREPARE_MARGIN_MINUTES = 30;
const TIME_ZONE = 'Asia/Shanghai';
const AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function parseAt(value) {
  const match = AT_PATTERN.exec(String(value || ''));
  if (!match) return null;
  const date = new Date(`${value}:00+08:00`);
  if (Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + 8 * 3600000);
  if (shifted.getUTCFullYear() !== Number(match[1]) || shifted.getUTCMonth() + 1 !== Number(match[2]) || shifted.getUTCDate() !== Number(match[3])
    || shifted.getUTCHours() !== Number(match[4]) || shifted.getUTCMinutes() !== Number(match[5])) return null;
  return date;
}
// 北京时间的 YYYY-MM-DDTHH:mm，供时间选择器的最早/最晚值使用。
function formatAt(ms) {
  const d = new Date(ms + 8 * 3600000), pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function limitFor(platform) { return Object.hasOwn(LIMITS, platform) ? LIMITS[platform] : null; }
function durationText(minutes) { return minutes % 60 === 0 ? `${minutes / 60}小时` : `${minutes}分钟`; }
function limitLabel(platform) {
  const limit = limitFor(platform);
  if (!limit) return '定时：平台无法识别';
  if (!limit.supported) return '定时：暂未接通，范围待核对';
  return `定时：${durationText(limit.minMinutes)}后～${limit.maxDays}天内`;
}
// 某个平台此刻可选的最早、最晚时间（毫秒）。strict 用在真正填写平台页面时，不再加上传预留。
function windowFor(platform, now = Date.now(), { strict = false } = {}) {
  const limit = limitFor(platform);
  if (!limit?.supported || !limit.known) return null;
  return { earliest: Math.ceil((now + (limit.minMinutes + (strict ? 0 : PREPARE_MARGIN_MINUTES)) * 60000) / 60000) * 60000, latest: now + limit.maxDays * 86400000 - (strict ? 0 : 3600000) };
}
// 返回空字符串表示可以；否则是给用户看的原因。
function scheduleIssue(platform, schedule, now = Date.now(), options = {}) {
  if (!schedule || schedule.mode !== 'scheduled') return '';
  const label = LABELS[platform] || platform, limit = limitFor(platform);
  if (!limit) return '平台无法识别，不能设置定时。';
  if (!limit.supported) return `${label}的定时发布尚未接通（${limit.evidence}）。请取消勾选${label}，或把这条改成立即发布；程序不会把定时悄悄改成立即发布。`;
  if (schedule.timeZone !== TIME_ZONE) return '定时发布时区必须是北京时间。';
  const at = parseAt(schedule.at);
  if (!at) return '请选择有效的定时发布时间（北京时间）。';
  const range = windowFor(platform, now, options);
  if (at.getTime() < range.earliest) {
    return options.strict
      ? `${label}要求定时时间在${durationText(limit.minMinutes)}之后；上传和填写完成时已不足，请改晚一些再发起。未提交。`
      : `${label}要求定时时间在${durationText(limit.minMinutes)}之后；算上上传和填写，请选 ${formatAt(range.earliest).replace('T', ' ')} 以后。`;
  }
  if (at.getTime() > range.latest) return `${label}只能定时到${limit.maxDays}天内，请选 ${formatAt(range.latest).replace('T', ' ')} 以前。`;
  return '';
}

const api = { LIMITS, PREPARE_MARGIN_MINUTES, limitFor, limitLabel, windowFor, scheduleIssue, formatAt, parseAt };
if (typeof module === 'object' && module.exports) module.exports = api;
else global.PublishSchedule = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
