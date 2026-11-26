'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../chrome-connector/account-identity.js'), 'utf8');
async function read(text, extra = {}) {
  const sandbox = { location: { origin: 'https://creator.douyin.com', pathname: '/creator-micro/home', ...extra }, document: { body: { innerText: text }, documentElement: {} }, MutationObserver: class { observe() {} disconnect() {} }, setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {}, Promise };
  Object.defineProperty(sandbox.document, 'cookie', { get() { throw new Error('Cookie read forbidden'); } });
  Object.defineProperty(sandbox, 'localStorage', { get() { throw new Error('Storage read forbidden'); } });
  return JSON.parse(JSON.stringify(await vm.runInNewContext(source, sandbox)));
}
test('只从唯一可见的抖音号标签取得身份，同一号重复出现允许', async () => {
  assert.equal((await read('账号概览\n抖音号：teacher_a\n累计播放 12345\n抖音号：teacher_a')).platformAccountId, 'teacher_a');
});
test('多个不同账号、只有昵称、其它站点或路径均不能确认', async () => {
  assert.equal(await read('抖音号：teacher_a\n抖音号：teacher_b'), null);
  assert.equal(await read('示例创作号 123456789'), null);
  assert.equal(await read('抖音号：teacher_a', { origin: 'https://example.com' }), null);
  assert.equal(await read('抖音号：teacher_a', { pathname: '/creator-micro/content/post/video' }), null);
});
