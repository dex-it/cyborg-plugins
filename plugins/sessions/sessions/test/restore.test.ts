// Вкладка сессии переживает выход процесса, перезапуск окна и хоста плагина: восстановление вручную (`resumeId`, `sessions.restore`), подхват оставленных pty.
// Автоматическое восстановление при запуске приложения не переносится (D-00, п. 6): вышедшая сессия ждёт человека.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryStore } from '@cyborg-harness/testing';
import { claudeArgs, prepare, rig, settle, until, UUID_A, UUID_B } from './kit.ts';

interface Opened {
  sessionId: string;
  title: string;
  ticket: string;
}
interface Previous {
  id: string;
  title: string;
  agent: string;
  resumable: boolean;
}

test('восстановление вручную: вышедшая сессия ждёт в той же вкладке и продолжается по id разговора агента', async () => {
  await using r = await rig();
  const first = (await r.run('sessions.create', { cwd: r.repoA, addDirs: [r.repoB] })) as Opened;
  const proc = r.last();
  await r.armed(proc);
  await r.hook(proc, { hook_event_name: 'SessionStart', session_id: UUID_A });
  await settle(200);
  const [doc] = r.kernel.documents;
  assert.ok(doc);
  assert.deepEqual(await r.run('sessions.previous'), [], 'идущая сессия - не прошлая');
  await assert.rejects(r.run('sessions.restore', doc.id), /уже идёт/);

  proc.exit(0);
  await until('выход', () => r.events.some((e) => e.change.type === 'exit'));
  assert.deepEqual(await r.run('sessions.previous'), [{ id: doc.id, title: first.title, agent: 'agent-claude-code', resumable: true }]);
  assert.deepEqual(await r.run('sessions.running'), []);

  const before = r.pty.procs.length;
  const second = (await r.run('sessions.restore', doc.id)) as Opened;
  assert.equal(r.pty.procs.length, before + 1);
  assert.deepEqual(r.kernel.documents.map((d) => d.id), [doc.id], 'та же вкладка, не новая');
  assert.equal(second.title, first.title, 'заголовок вкладки прежний');
  assert.notEqual(second.sessionId, first.sessionId);
  const restored = r.last();
  assert.deepEqual(claudeArgs(restored).slice(0, 2), ['--resume', UUID_A]);
  assert.equal(restored.options.cwd, r.repoA);
  assert.deepEqual(restored.args.slice(-2), ['--add-dir', r.repoB], 'каталоги запуска те же');
  assert.deepEqual(await r.run('sessions.previous'), []);
  await assert.rejects(r.sessions.reveal(first.sessionId), /вкладки нет/, 'прежний id сессии вкладку больше не называет');
  await r.sessions.reveal(second.sessionId);

  // Восстановленная сессия сообщает о себе под новым id.
  await r.armed(restored);
  await r.hook(restored, { hook_event_name: 'PostToolUse', tool_name: 'Read' });
  await until('событие восстановленной', () => r.events.some((e) => e.sessionId === second.sessionId && e.change.type === 'activity'));
  r.clean();
});

test('восстановление: новый разговор агента заменяет id продолжения; без id вкладка стартует заново; чужие и негодные данные отказ', async () => {
  await using r = await rig();
  await r.run('sessions.create', { cwd: r.repoA });
  const proc = r.last();
  await r.armed(proc);
  await r.hook(proc, { hook_event_name: 'SessionStart', session_id: UUID_A });
  await r.hook(proc, { hook_event_name: 'SessionStart', session_id: UUID_B });
  await settle(200);
  const [doc] = r.kernel.documents;
  assert.ok(doc);
  proc.exit(0);
  await until('выход', () => r.events.some((e) => e.change.type === 'exit'));
  await r.run('sessions.restore', doc.id);
  assert.deepEqual(claudeArgs(r.last()).slice(0, 2), ['--resume', UUID_B], 'после /clear продолжается последний разговор');
  await assert.rejects(r.run('sessions.restore', 'нет-такой'), /документа нет-такой нет/);

  // Сессия, у которой агент не дошёл до SessionStart: id продолжения нет, вкладка запускает новую сессию.
  await r.run('sessions.create', { cwd: r.repoB });
  const fresh = r.last();
  const [, second] = r.kernel.documents;
  assert.ok(second);
  fresh.exit(2);
  await until('выход', () => r.events.filter((e) => e.change.type === 'exit').length >= 2);
  assert.deepEqual(((await r.run('sessions.previous')) as Previous[]).filter((p) => p.id === second.id).map((p) => p.resumable), [false]);
  await r.run('sessions.restore', second.id);
  assert.ok(!r.last().args.includes('--resume'));
});

test('восстановление проходит ту же проверку каталогов: репозиторий убран из проектов - отказ, процесс не запущен', async () => {
  await using r = await rig();
  await r.run('sessions.create', { cwd: r.repoA });
  const [doc] = r.kernel.documents;
  assert.ok(doc);
  r.last().exit(0);
  await until('выход', () => r.events.some((e) => e.change.type === 'exit'));
  const before = r.pty.procs.length;
  r.projects.repos = [r.repoB];
  await assert.rejects(r.run('sessions.restore', doc.id), /Каталог не входит в репозитории проектов/);
  assert.equal(r.pty.procs.length, before);
  assert.equal(((await r.run('sessions.previous')) as Previous[]).length, 1, 'вкладка остаётся: человек вернёт проект и повторит');
});

test('перезапуск приложения: вкладки прошлого запуска ждут восстановления, процессов не запускают (eager не переносится)', async () => {
  const state = memoryStore();
  const shared = await prepare();
  try {
    {
      await using r = await rig({ state: state.store, shared });
      await r.run('sessions.create', { cwd: r.repoA });
      await r.run('sessions.create', { cwd: r.repoB });
      assert.equal(r.kernel.documents.length, 2);
    }
    await using again = await rig({ state: state.store, shared });
    assert.equal(again.pty.procs.length, 0, 'ни одного процесса при старте');
    const previous = (await again.run('sessions.previous')) as Previous[];
    assert.deepEqual(previous.map((p) => p.title).toSorted(), ['Claude Code 1', 'Claude Code 2']);
    assert.deepEqual(await again.run('sessions.running'), []);
    const [one] = previous;
    assert.ok(one);
    await again.run('sessions.restore', one.id);
    assert.equal(again.pty.procs.length, 1);
    assert.equal(((await again.run('sessions.previous')) as Previous[]).length, 1);
  } finally {
    await shared.dispose();
  }
});

test('хост плагина перезапущен, pty живы: плагин подхватывает их при активации, а ядро не завершает по сроку (S16)', async () => {
  await using r = await rig({ os: { ptyOrphanGrace: 150 } });
  const opened = (await r.run('sessions.create', { cwd: r.repoA })) as Opened;
  const proc = r.last();
  const [doc] = r.kernel.documents;
  assert.ok(doc);
  assert.deepEqual(await r.run('sessions.running'), [{ id: doc.id, sessionId: opened.sessionId, title: opened.title, pid: proc.pid }]);

  await r.kernel.disable('sessions', { keepPty: true });
  proc.emit('пока плагин выключен\r\n');
  await r.kernel.enable('sessions');
  // Льготный срок ядра начался с активации: без attach процесс был бы завершён с записью pty-expired.
  await settle(400);
  assert.equal(proc.killed, undefined, 'плагин не подхватил оставленный pty, ядро завершило его по сроку');
  assert.deepEqual(r.kernel.journal.filter((e) => e.kind === 'pty-expired'), []);
  assert.deepEqual(r.kernel.keptPty(), [], 'подхваченный процесс остался в списке оставленных');
  const running = (await r.run('sessions.running')) as { id: string; sessionId: string; pid: number }[];
  assert.deepEqual(running.map((s) => [s.id, s.sessionId, s.pid]), [[doc.id, opened.sessionId, proc.pid]], 'тот же документ, тот же id сессии, тот же процесс');
  assert.deepEqual(await r.run('sessions.previous'), [], 'идущая сессия - не прошлого запуска');

  // Окно открывает её заново по новому билету; чужой и неизвестный документ - отказ.
  const reopened = (await r.run('sessions.reopen', doc.id)) as Opened;
  assert.equal(typeof reopened.ticket, 'string');
  assert.equal(reopened.sessionId, opened.sessionId);
  await assert.rejects(r.run('sessions.reopen', 'нет-такого'), /сессии нет-такого нет/);

  // Подхваченная сессия слушает хуки и выходит, как обычная.
  await r.armed(proc);
  await r.hook(proc, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  await until('waiting подхваченной сессии', () => r.events.some((e) => e.sessionId === opened.sessionId && e.change.type === 'waiting'));
  proc.exit(0);
  await until('exit подхваченной сессии', () => r.events.some((e) => e.sessionId === opened.sessionId && e.change.type === 'exit'));
  await until('вышла', async () => ((await r.run('sessions.running')) as unknown[]).length === 0);
  assert.equal(((await r.run('sessions.previous')) as Previous[]).length, 1);
});

test('процесс вышел, пока плагин был выключен: подхват отдаёт выход, вкладка ждёт восстановления', async () => {
  await using r = await rig({ os: { ptyOrphanGrace: 150 } });
  await r.run('sessions.create', { cwd: r.repoA });
  const proc = r.last();
  await r.kernel.disable('sessions', { keepPty: true });
  proc.exit(3);
  await r.kernel.enable('sessions');
  assert.deepEqual(await r.run('sessions.running'), [], 'вышедший процесс числится идущим');
  assert.equal(((await r.run('sessions.previous')) as Previous[]).length, 1, 'вкладка вышедшей сессии пропала');
  assert.deepEqual(r.kernel.keptPty(), []);
});
