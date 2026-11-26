'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function clone(value) {
  return structuredClone(value);
}

function assertRoot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('数据根节点必须是对象');
  }
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

function replaceFileSync(temporaryPath, targetPath) {
  const maxAttempts = process.platform === 'win32' ? 6 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(temporaryPath, targetPath);
      return;
    } catch (error) {
      if (attempt < maxAttempts && RETRYABLE_RENAME_CODES.has(error?.code)) {
        sleepSync(25 * attempt);
        continue;
      }
      throw error;
    }
  }
}

class JsonStore {
  constructor(filePath, initialObject) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath必须是非空字符串');
    assertRoot(initialObject);
    this.filePath = path.resolve(filePath);
    this.initialObject = clone(initialObject);
    this.state = undefined;
  }

  load() {
    if (this.state === undefined) {
      try {
        const contents = fs.readFileSync(this.filePath, 'utf8');
        let parsed;
        try {
          parsed = JSON.parse(contents);
          assertRoot(parsed);
        } catch (error) {
          throw new Error('数据文件损坏', { cause: error });
        }
        this.state = parsed;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const initial = clone(this.initialObject);
        this.#writeAtomically(initial);
        this.state = initial;
      }
    }
    return clone(this.state);
  }

  update(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('mutator必须是函数');
    if (this.state === undefined) this.load();
    const next = clone(this.state);
    const result = mutator(next);
    if (result && typeof result.then === 'function') throw new TypeError('mutator必须同步完成');
    assertRoot(next);
    this.#writeAtomically(next);
    this.state = next;
    return clone(this.state);
  }

  #writeAtomically(value) {
    const directory = path.dirname(this.filePath);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('数据无法序列化');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(directory, `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(handle, serialized, 'utf8');
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = undefined;
      replaceFileSync(temporaryPath, this.filePath);
    } catch (error) {
      if (handle !== undefined) { try { fs.closeSync(handle); } catch {} }
      try { fs.unlinkSync(temporaryPath); } catch {}
      throw error;
    }
  }
}

module.exports = { JsonStore, replaceFileSync };
