// Контракт cyborg.sessions 1.2 глазами чужого плагина (`probe`): члены ядра (onChange, reveal) и члены расширения (create, send, paste, метки, find, uses).
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { memoryStore, type InlinePlugin } from '@cyborg-harness/testing';
import { rig, settle, until } from './kit.ts';

const task = (key: string, title = 'Дерево файлов') => ({ key, title, status: 'открыта', url: `https://tracker/${key}` });

const needs = (id: string, range: string): InlinePlugin => ({ manifest: { id, version: '1.0.0', engines: { cyborg: '^1' }, requires: { 'cyborg.sessions': range } }, module: { activate: () => undefined } });

test('поставщик отдаёт версию 1.2 и все члены каталога контрактов', async () => {
  await using r = await rig({ extra: [needs('needs-12', '^1.2'), needs('needs-13', '^1.3')] });
  // Версия: потребитель, которому нужна 1.2, получает поставщика; которому нужна 1.3, - нет.
  assert.ok(r.kernel.active.includes('needs-12'));
  assert.ok(!r.kernel.active.includes('needs-13'));
  assert.deepEqual(r.kernel.journal.filter((e) => e.kind === 'rejected').map((e) => e.pluginId), ['needs-13'], 'отвергнут только тот, кому нужна 1.3');
  for (const member of ['onChange', 'reveal', 'create', 'send', 'paste', 'labels', 'setLabels', 'find', 'uses']) {
    assert.equal(typeof (r.sessions as unknown as Record<string, unknown>)[member], 'function', member);
  }
});

test('create: сессия открывается с привязкой с первого кадра, вкладка получает документ, reveal просит окно показать её', async () => {
  const revealed: string[] = [];
  await using r = await rig({ load: { onDocumentReveal: (id) => void revealed.push(id) } });
  const handle = await r.sessions.create({ cwd: r.repoA, labels: { task: task('p1#7') } });
  assert.deepEqual(await r.sessions.labels(handle.sessionId), { task: task('p1#7') });
  assert.equal(await r.sessions.find('task', 'p1#7'), handle.sessionId);
  const [doc] = r.kernel.documents;
  assert.ok(doc);
  assert.equal(doc.title, handle.title);
  await r.sessions.reveal(handle.sessionId);
  assert.deepEqual(revealed, [doc.id]);
  await assert.rejects(r.sessions.reveal('s-net'), /вкладки нет/);
  await assert.rejects(r.sessions.reveal('../x'), /id сессии/);
});

test('onChange: подписчик получает события всех сессий; тексты запросов и ответов в события не идут', async () => {
  await using r = await rig();
  const first = await r.sessions.create({ cwd: r.repoA });
  const procA = r.last();
  const second = await r.sessions.create({ cwd: r.repoB });
  const procB = r.last();
  await r.armed(procA);
  await r.armed(procB);
  await r.hook(procA, { hook_event_name: 'PostToolUse', tool_name: 'Edit' });
  await r.hook(procB, { hook_event_name: 'Notification', notification_type: 'agent_needs_input' });
  await until('два события', () => r.events.length >= 2);
  assert.deepEqual(r.events.find((e) => e.sessionId === first.sessionId)?.change, { type: 'activity', tool: 'Edit' });
  assert.deepEqual(r.events.find((e) => e.sessionId === second.sessionId)?.change, { type: 'waiting', reason: 'Ждёт ответа' });
  // Запрос человека - тоже работа; `session` и `turnEnd` контракт ядра не отдаёт.
  r.events.length = 0;
  await r.hook(procA, { hook_event_name: 'SessionStart', session_id: '11111111-1111-1111-1111-111111111111' });
  await r.hook(procA, { hook_event_name: 'UserPromptSubmit', prompt: 'секретный запрос' });
  await r.hook(procA, { hook_event_name: 'Stop', last_assistant_message: 'секретный ответ', background_tasks: [{ id: 'b' }] });
  await until('activity запроса', () => r.events.length >= 1);
  await settle(150);
  assert.deepEqual(r.events.map((e) => e.change), [{ type: 'activity' }]);
  assert.ok(!JSON.stringify(r.events).includes('секретн'), 'тексты запросов и ответов в события не идут');
  r.clean();
});

test('метки: привязка задачи и MR ставится, снимается null, правка не названного поля его не трогает', async () => {
  await using r = await rig();
  const { sessionId } = await r.sessions.create({ cwd: r.repoA });
  assert.deepEqual(await r.sessions.labels(sessionId), {});
  assert.equal(await r.sessions.labels('s-net'), null);
  assert.deepEqual(await r.sessions.setLabels(sessionId, { task: task('p1#7') }), { task: task('p1#7') });
  assert.deepEqual(await r.sessions.setLabels(sessionId, { mr: task('p1!3', 'MR дерева') }), { task: task('p1#7'), mr: task('p1!3', 'MR дерева') });
  // Статус обновляется тем же ключом: заголовок вкладки идёт за панелью трекера.
  assert.deepEqual((await r.sessions.setLabels(sessionId, { task: { ...task('p1#7'), status: 'закрыта' } })).task?.status, 'закрыта');
  assert.deepEqual(await r.sessions.setLabels(sessionId, { task: null }), { mr: task('p1!3', 'MR дерева') });
  assert.equal(await r.sessions.find('task', 'p1#7'), null);
  assert.equal(await r.sessions.find('mr', 'p1!3'), sessionId);
  await assert.rejects(r.sessions.setLabels('s-net', { task: task('x') }), /нет сессии/);
  await assert.rejects(r.sessions.setLabels(sessionId, { task: { key: '', title: 't' } }), /key/);
  await assert.rejects(r.sessions.find('epic' as never, 'x'), /task или mr/);
});

test('метки: объект трекера - у одной сессии; выход сессии снимает привязку, закрытая вкладка забирает метки с собой', async () => {
  await using r = await rig();
  const a = await r.sessions.create({ cwd: r.repoA, labels: { task: task('p1#7') } });
  const procA = r.last();
  const b = await r.sessions.create({ cwd: r.repoB });
  await r.sessions.setLabels(b.sessionId, { task: task('p1#7') });
  assert.equal(await r.sessions.find('task', 'p1#7'), b.sessionId, 'привязку забрала новая сессия');
  assert.deepEqual(await r.sessions.labels(a.sessionId), {});
  await r.sessions.setLabels(a.sessionId, { mr: task('p1!3') });
  procA.exit(0);
  await until('выход', () => r.events.some((e) => e.sessionId === a.sessionId && e.change.type === 'exit'));
  assert.equal(await r.sessions.find('mr', 'p1!3'), null, 'вышедшая сессия задачу не держит');
  const docB = r.kernel.documents.find((d) => d.title === b.title);
  assert.ok(docB);
  await r.kernel.closeDocument(docB.id);
  assert.equal(await r.sessions.find('task', 'p1#7'), null);
  assert.equal(await r.sessions.labels(b.sessionId), null);
});

test('send и paste доходят до терминала сессии; пустая сессия и вышедшая - отказ с причиной', async () => {
  await using r = await rig();
  const { sessionId } = await r.sessions.create({ cwd: r.repoA });
  const proc = r.last();
  await r.sessions.send(sessionId, '/clear\r');
  await r.sessions.paste(sessionId, 'строка 1\nстрока 2');
  assert.deepEqual(proc.writes, ['/clear\r', '\x1b[200~строка 1\nстрока 2\x1b[201~']);
  await r.sessions.paste(sessionId, 'итог', { submit: true });
  assert.deepEqual(proc.writes.slice(2), ['\x1b[200~итог\x1b[201~', '\r']);
  await assert.rejects(r.sessions.send('s-net', 'x'), /завершилась или её нет/);
  proc.exit(0);
  await until('выход', () => r.events.some((e) => e.change.type === 'exit'));
  await assert.rejects(r.sessions.send(sessionId, 'x'), /завершилась или её нет/);
  await assert.rejects(r.sessions.paste(sessionId, 'x'), /завершилась или её нет/);
});

test('привязка задачи и MR к сессии только в памяти (FR-1015, FR-2014): ни в документе вкладки, ни в состоянии, ни в данных плагинов на диске', async () => {
  const state = memoryStore();
  await using r = await rig({ state: state.store });
  const { sessionId } = await r.sessions.create({ cwd: r.repoA, labels: { task: task('p1#уник-задача', 'Название-уник-задача'), mr: task('p1!уник-mr', 'Название-уник-mr') } });
  await r.sessions.setLabels(sessionId, { task: { ...task('p1#уник-задача', 'Название-уник-задача'), status: 'статус-уник' } });
  const proc = r.last();
  await r.armed(proc);
  await r.hook(proc, { hook_event_name: 'SessionStart', session_id: '11111111-1111-1111-1111-111111111111' });
  await settle(300);
  const walk = async (dir: string): Promise<string[]> =>
    (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async (e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [await readFile(path.join(dir, e.name), 'utf8').catch(() => '')])))).flat();
  const onDisk = (await walk(path.dirname(r.kernel.dataDir('sessions')))).join('\n');
  const stored = JSON.stringify([...state.docs]);
  const documents = JSON.stringify(r.kernel.documents);
  for (const secret of ['уник-задача', 'уник-mr', 'статус-уник']) {
    assert.ok(!onDisk.includes(secret), `${secret}: на диске в данных плагинов`);
    assert.ok(!stored.includes(secret), `${secret}: в сохранённом состоянии`);
    assert.ok(!documents.includes(secret), `${secret}: в документах вкладок`);
  }
  assert.ok(stored.includes('11111111-1111-1111-1111-111111111111'), 'а id продолжения в документе есть: он нужен для восстановления вручную');
});
