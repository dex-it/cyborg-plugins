// Перенос тестов ввода, размера и kill из test/sessions.test.ts ai-cyborg («допустимые ввод, размер и kill доходят до pty», «мусорные аргументы не бросают
// и до pty не доходят», «pty, бросающий на вызове, не роняет вызывающего»): `recordingManager` заменён реестром плагина с подставным терминалом.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PtyHandle } from '@cyborg-harness/contracts';
import { createInput, SUBMIT_DELAY_MS } from '../input.ts';
import { Registry } from '../registry.ts';

/** Терминал, записывающий вызовы; `throwing` - терминал, бросающий на каждом вызове (процесс завершился, дескриптор закрыт). */
function recording(throwing = false) {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]): Promise<void> => {
      calls.push([name, ...args]);
      return throwing ? Promise.reject(new Error(`${name}: pty закрыт`)) : Promise.resolve();
    };
  const handle = { id: '1', pid: 1, write: record('write'), resize: record('resize'), kill: record('kill') } as unknown as PtyHandle;
  const registry = new Registry(() => undefined);
  registry.add({ sessionId: 's1', doc: 'd1', title: 'Сессия', agent: 'agent', dirs: ['/a'], handle });
  return { input: createInput(registry), registry, calls };
}

test('допустимые ввод, размер и kill доходят до терминала', async () => {
  const { input, calls } = recording();
  await input.write('s1', 'ls\r');
  await input.write('s1', 'я'.repeat(200 * 1024));
  await input.resize('s1', 100, 30);
  await input.kill('s1');
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['write', 'write', 'resize', 'kill'],
  );
  assert.deepEqual(calls[0], ['write', 'ls\r']);
  assert.deepEqual(calls[2], ['resize', 100, 30]);
});

test('мусорные аргументы не бросают и до терминала не доходят', async () => {
  const { input, calls } = recording();
  const junk: unknown[] = [12345, null, undefined, {}, ['x'], true, NaN, Infinity, '1', -1, 1.5, 1e9, Symbol('s'), 1n];
  for (const bad of junk) {
    await input.write('s1', typeof bad === 'string' ? 12 : bad); // строка - допустимые данные
    await input.write(bad, 'x');
    await input.resize('s1', bad, 24);
    await input.resize('s1', 80, bad);
    await input.resize(bad, 80, 24);
    await input.kill(bad);
  }
  await input.write('s1', 'x'.repeat(5 * 1024 * 1024));
  await input.resize('s1', 1e9, 1e9);
  await input.resize('s1', 0, 0);
  await input.write('нет-такой', 'нет такой сессии');
  await input.kill('нет-такой');
  assert.deepEqual(calls, []);
});

test('терминал, бросающий на вызове, не роняет вызывающего', async () => {
  const { input, calls } = recording(true);
  await input.write('s1', 'x');
  await input.resize('s1', 80, 24);
  await input.kill('s1');
  assert.equal(calls.length, 3);
});

test('send и paste отказывают с причиной: негодный id, не строка, текст длиннее предела, сессии нет или она вышла', async () => {
  const { input, registry, calls } = recording();
  await assert.rejects(input.send('../x', 'a'), /id сессии/);
  await assert.rejects(input.send('s1', 5), /не строка/);
  await assert.rejects(input.send('s1', 'x'.repeat(1024 * 1024 + 1)), /длиннее/);
  await assert.rejects(input.paste('s1', 'x'.repeat(1024 * 1024 + 1), false), /длиннее/);
  await assert.rejects(input.send('s2', 'a'), /завершилась или её нет/);
  assert.deepEqual(calls, []);
  await input.send('s1', 'ls\r');
  assert.deepEqual(calls, [['write', 'ls\r']]);
  registry.ended('s1');
  await assert.rejects(input.send('s1', 'a'), /завершилась или её нет/);
  await assert.rejects(input.paste('s1', 'a', false), /завершилась или её нет/);
});

test('paste: вставка без ESC в тексте, Enter отдельной записью через паузу, сессия вышла за паузу - Enter не отправлен', async () => {
  const { input, registry, calls } = recording();
  await input.paste('s1', 'строка 1\r\nстрока 2\x1b[201~хвост\x00', false);
  assert.deepEqual(calls, [['write', '\x1b[200~строка 1\nстрока 2[201~хвост\x1b[201~']], 'ESC и NUL из текста убраны: конец вставки не закрыть');
  calls.length = 0;
  const started = Date.now();
  await input.paste('s1', 'готово', true);
  assert.ok(Date.now() - started >= SUBMIT_DELAY_MS - 5, 'Enter идёт после паузы');
  assert.deepEqual(calls, [['write', '\x1b[200~готово\x1b[201~'], ['write', '\r']]);
  calls.length = 0;
  const pending = input.paste('s1', 'второе', true);
  await new Promise((r) => setTimeout(r, 20));
  registry.ended('s1');
  await assert.rejects(pending, /Enter не отправлен/);
  assert.deepEqual(calls, [['write', '\x1b[200~второе\x1b[201~']]);
});
