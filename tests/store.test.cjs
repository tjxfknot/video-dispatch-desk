'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../app/core/store.cjs');

async function tempDir() { return fs.mkdtemp(path.join(os.tmpdir(), 'publisher-store-')); }

test('creates private storage, deep-copies values, and reloads atomic updates', async t => {
  const directory = await tempDir();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'nested', 'state.json');
  const store = new JsonStore(file, { runs: [], nested: { value: 1 } });
  const loaded = await store.load();
  loaded.nested.value = 20;
  assert.equal((await store.load()).nested.value, 1);
  await store.update(state => { state.nested.value = 2; state.runs.push({ id: 'r1' }); });
  const disk = new JsonStore(file, {});
  assert.deepEqual(await disk.load(), { runs: [{ id: 'r1' }], nested: { value: 2 } });
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  }
});

test('corrupt JSON is reported and never overwritten', async t => {
  const directory = await tempDir();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'bad.json');
  await fs.writeFile(file, '{not json');
  const store = new JsonStore(file, { safe: true });
  assert.throws(() => store.load(), /数据文件损坏/);
  assert.equal(await fs.readFile(file, 'utf8'), '{not json');
});

test('write and mutator failures preserve memory and clean temporary files', async t => {
  const directory = await tempDir();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const store = new JsonStore(file, { value: 1 });
  await store.load();
  assert.throws(() => store.update(state => { state.value = 2; throw new Error('callback failed'); }), /callback failed/);
  assert.deepEqual(await store.load(), { value: 1 });
  await fs.unlink(file);
  await fs.mkdir(file);
  assert.throws(() => store.update(state => { state.value = 3; }), /EISDIR|directory|File exists/i);
  assert.deepEqual(await store.load(), { value: 1 });
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), []);
});

test('rejects non-object roots and leaves cached state unchanged after serialization failures', async t => {
  const directory = await tempDir();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.throws(() => new JsonStore(path.join(directory, 'array.json'), []), /必须是对象/);
  const store = new JsonStore(path.join(directory, 'state.json'), { value: 1 });
  await store.load();
  assert.throws(() => store.update(state => { state.value = 2n; }), /BigInt|serialize/i);
  assert.deepEqual(await store.load(), { value: 1 });
});
