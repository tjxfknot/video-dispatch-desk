'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { replaceFileSync } = require('./store.cjs');

// Browser-connection credentials are separate from the user's library and exports.
class ConnectionVault {
  constructor({ file, encryption }) {
    this.file = file;
    this.encryption = encryption;
    this.cache = null;
  }
  load() {
    if (this.cache) return this.cache;
    if (!this.encryption.isEncryptionAvailable() || (process.platform === 'linux' && this.encryption.getSelectedStorageBackend?.() === 'basic_text')) throw new Error('系统安全存储不可用，暂不能保存账号连接；未改动原数据。');
    let value = {};
    if (fs.existsSync(this.file)) {
      try { value = JSON.parse(this.encryption.decryptString(fs.readFileSync(this.file))); }
      catch { throw new Error('账号连接凭据无法解密；请保留文件并重新连接，不会自动清空。'); }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('账号连接凭据格式不正确。');
    this.cache = value;
    return value;
  }
  get(id) { return structuredClone(this.load()[id] || null); }
  set(id, value) {
    const next = { ...this.load() };
    if (value === null) delete next[id]; else next[id] = structuredClone(value);
    const encrypted = this.encryption.encryptString(JSON.stringify(next));
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' });
      replaceFileSync(temporary, this.file);
      if (process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
      this.cache = next;
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}

module.exports = { ConnectionVault };
