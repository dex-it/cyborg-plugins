// Перенос src/main/child-sessions.test.ts ai-cyborg. Утверждения те же; хранилище у плагина асинхронное (шлюз `ctx.os.fs`), поэтому `add` и `all` - обещания,
// а в роли шлюза - файловая система теста.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChildSessions, type TextFiles } from '../child-sessions.ts';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

const disk: TextFiles = {
  readText: async (file) => fs.readFileSync(file, 'utf8'),
  writeText: async (file, text) => fs.writeFileSync(file, text),
};

test('ChildSessions: номер разговора запоминается между экземплярами, мусор и повтор не пишутся', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-child-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'child-sessions.json');
  assert.deepEqual([...(await new ChildSessions(file, disk).all())], []);
  const store = new ChildSessions(file, disk);
  await store.add(A);
  await store.add('не-номер');
  await store.add(B);
  await store.add(A);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [B, A]);
  assert.deepEqual([...(await new ChildSessions(file, disk).all())].sort(), [A, B]);
});

test('ChildSessions: битый файл читается как пустой перечень и перезаписывается', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-child-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'child-sessions.json');
  fs.writeFileSync(file, '{не json');
  const store = new ChildSessions(file, disk);
  assert.equal((await store.all()).size, 0);
  await store.add(A);
  assert.deepEqual([...(await store.all())], [A]);
});

test('ChildSessions: два номера подряд без ожидания не теряют друг друга; ошибка записи не роняет плагин', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-child-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ChildSessions(path.join(dir, 'child-sessions.json'), disk);
  void store.add(A);
  void store.add(B);
  assert.deepEqual([...(await store.all())].sort(), [A, B]);
  const errors: unknown[] = [];
  const broken = new ChildSessions(path.join(dir, 'child-sessions.json'), { readText: disk.readText, writeText: async () => Promise.reject(new Error('диск полон')) });
  await broken.add(A, (e) => void errors.push(e));
  assert.equal(errors.length, 1);
});
