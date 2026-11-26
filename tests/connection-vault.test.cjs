'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { ConnectionVault } = require('../app/core/connection-vault.cjs');
function cipher() {
  const key = crypto.randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
    decryptString(value) { const d = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8'); } };
}
test('凭据单独加密落盘、重读和撤销，不存明文', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-vault-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'connection.enc'), encryption = cipher(), vault = new ConnectionVault({ file, encryption });
  vault.set('synthetic', { token: 'synthetic-private-token', origin: 'chrome-extension://test' });
  assert.equal(fs.readFileSync(file).includes(Buffer.from('synthetic-private-token')), false);
  assert.equal(new ConnectionVault({ file, encryption }).get('synthetic').token, 'synthetic-private-token');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  vault.set('synthetic', null); assert.equal(new ConnectionVault({ file, encryption }).get('synthetic'), null);
});
test('系统加密不可用或文件损坏时保留原件并停止', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-vault-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'connection.enc');
  assert.throws(() => new ConnectionVault({ file, encryption: { isEncryptionAvailable: () => false } }).load(), /安全存储/);
  assert.equal(fs.existsSync(file), false); fs.writeFileSync(file, 'broken original');
  assert.throws(() => new ConnectionVault({ file, encryption: cipher() }).load(), /解密/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken original');
});
