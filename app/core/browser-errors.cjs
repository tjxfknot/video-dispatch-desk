'use strict';

// Error messages from the browser can contain URLs, headers and form text.
// Keep only an operation name and a small, controlled error classification.
const STAGES = new Set(['read_current', 'open_identity', 'read_identity', 'save_binding', 'confirm_identity']);
function browserFailure(error, stage = 'read_current') {
  const message = String(error?.message || '');
  const errorCode = message.match(/(?:net::)?ERR_[A-Z_]+/)?.[0] || '';
  const operation = STAGES.has(error?.connectionStage) ? error.connectionStage : STAGES.has(stage) ? stage : 'read_current';
  const httpStatus = Number.isInteger(error?.httpStatus) ? error.httpStatus : null;
  const runtimeLine = `${error?.name || 'Error'}: ${message.split('\n')[0]}`;
  const runtimeError = runtimeLine.match(/(?:TypeError|ReferenceError|SyntaxError|EvalError):[^\n]{0,180}/)?.[0]
    ?.replace(/https?:\/\/\S+/g,'[url]').replace(/[a-f0-9]{24,}/gi,'[id]') || '';
  const category = /closed|关闭|Target page|browser has been closed/i.test(message) ? 'window_closed'
    : httpStatus ? 'server_response'
    : error?.name === 'TimeoutError' || /timeout|timed out|超时/i.test(message) ? 'timeout'
    : errorCode ? 'network'
    : /Execution context was destroyed|Cannot find context|导航|navigation/i.test(message) ? 'page_changing'
    : operation === 'save_binding' ? 'binding_write' : 'page_read';
  const where = operation === 'open_identity' ? '打开账号校验页' : operation === 'save_binding' ? '保存账号连接' : '读取账号';
  const detail = category === 'window_closed' ? '专属浏览器或账号标签已关闭'
    : category === 'timeout' ? '页面响应超时'
    : category === 'server_response' ? `官方页面返回 HTTP ${httpStatus}`
    : category === 'network' ? `网络请求失败（${errorCode}）`
    : category === 'page_changing' ? '官方页面仍在切换'
    : category === 'binding_write' ? '账号连接未能保存' : '页面内容未能读回';
  return { operation, category, errorCode, httpStatus, ...(runtimeError?{runtimeError}:{}),
    message: `${where}未完成：${detail}。原登录和输入保留，请点击“继续连接”；不必重复扫码。` };
}
module.exports = { browserFailure };
