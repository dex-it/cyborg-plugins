// Сборка системного промпта сессии из фрагментов cyborg.session-prompt (FR-9001, FR-9002, FR-9003).
// Порядок: по id плагина-поставщика (решение владельца D-00, п. 3; явного порядка в ядре нет - cyborg-harness#259). Фактический порядок зафиксирован тестом.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { collectFragments } from '../prompt.ts';
import { ISOLATION_DIR, promptProvider, rig } from './kit.ts';

const isolation = (await readFile(path.join(ISOLATION_DIR, 'test', 'fixtures', 'isolation-prompt.txt'), 'utf8')).replace(/\n$/, '');
const KNOPKI = 'КНОПКИ СЛЕДУЮЩИХ ШАГОВ';

/** Значение `--append-system-prompt` из аргументов запуска. */
const systemPrompt = (args: readonly string[]): string | undefined => args[args.indexOf('--append-system-prompt') + 1];

test('в каждой сессии есть инструкция изоляции дословно (FR-9001, FR-9003): её передаёт sessions, worktree он не создаёт', async () => {
  await using r = await rig();
  await r.sessions.create({ cwd: r.repoA });
  await r.sessions.create({ cwd: r.repoB, addDirs: [r.repoA], prompt: 'задача' });
  for (const proc of r.pty.procs) assert.equal(systemPrompt(proc.args), isolation);
  assert.ok(r.pty.procs.every((p) => !p.args.includes('worktree')), 'sessions не просит агента создавать worktree сам');
  r.clean();
});

test('порядок фрагментов - по id плагина: next-actions стоит раньше session-isolation, расхождение с ai-cyborg (изоляция первой) принято до cyborg-harness#259', async () => {
  await using r = await rig({ extra: [promptProvider('next-actions', KNOPKI)] });
  await r.sessions.create({ cwd: r.repoA });
  // ai-cyborg: ISOLATION_PROMPT, пустая строка, SUGGEST_PROMPT. Здесь порядок по id: кнопки, потом изоляция.
  assert.equal(systemPrompt(r.last().args), `${KNOPKI}\n\n${isolation}`);
  assert.notEqual(systemPrompt(r.last().args), `${isolation}\n\n${KNOPKI}`);
});

test('порядок не зависит от порядка загрузки плагинов и от числа поставщиков', async () => {
  await using r = await rig({ extra: [promptProvider('zz-last', 'ПОСЛЕДНИЙ'), promptProvider('aa-first', 'ПЕРВЫЙ'), promptProvider('mm-middle', 'СЕРЕДИНА')] });
  await r.sessions.create({ cwd: r.repoA });
  assert.equal(systemPrompt(r.last().args), `ПЕРВЫЙ\n\nСЕРЕДИНА\n\n${isolation}\n\nПОСЛЕДНИЙ`);
});

test('пустой вклад и вклад из пробелов отбрасываются; без поставщиков промпта флага нет', async () => {
  await using r = await rig({ noIsolation: true, extra: [promptProvider('a-empty', ''), promptProvider('b-blank', '  \n ')] });
  await r.sessions.create({ cwd: r.repoA });
  assert.ok(!r.last().args.includes('--append-system-prompt'));
  await using only = await rig({ noIsolation: true, extra: [promptProvider('a-empty', ''), promptProvider('c-real', 'ТЕКСТ')] });
  await only.sessions.create({ cwd: only.repoA });
  assert.equal(systemPrompt(only.last().args), 'ТЕКСТ');
});

test('сломанный поставщик запуску не мешает: вклад пропущен, причина в журнале', async () => {
  const broken = promptProvider('broken', () => {
    throw new Error('сломан');
  });
  await using r = await rig({ extra: [broken] });
  await r.sessions.create({ cwd: r.repoA });
  assert.equal(systemPrompt(r.last().args), isolation);
  assert.ok(r.logs.some((m) => m.startsWith('broken: фрагмент промпта')));
});

test('collectFragments: порядок по id без привязки к порядку списка', async () => {
  const provider = (pluginId: string, text: string) => ({ pluginId, version: '1.0', impl: { fragment: () => Promise.resolve(text) } });
  const out = await collectFragments([provider('b', 'Б'), provider('a', 'А'), provider('c', '')], () => undefined);
  assert.deepEqual(out, ['А', 'Б']);
});
