// Состояние сессий для инструментов делегирования, очередь сообщений и итог дочерней (FR-15005, FR-15007, FR-15008, FR-15010).
// Перенос утверждений SessionManager.say / enqueue / reportLocal / peers из src/main/sessions.test.ts ai-cyborg: вместо хуков из файла - события агента (`AgentEvent`),
// вместо node-pty - запись в подставной терминал. Тишина после события (2 с в ai-cyborg) здесь задаётся тестом.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent, PtyHandle } from '@cyborg-harness/contracts';
import { ChildSessions } from '../child-sessions.ts';
import { Delegation, OUTBOX_QUIET_MS } from '../delegation.ts';
import { SUBMIT_DELAY_MS } from '../input.ts';
import { Registry, type Tab } from '../registry.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function rig(quietMs = 0) {
  const registry = new Registry(() => undefined);
  const stored = new Map<string, string>();
  const children = new ChildSessions('/c.json', { readText: async (f) => stored.get(f) ?? Promise.reject(new Error('нет')), writeText: async (f, t) => void stored.set(f, t) });
  const notes: string[] = [];
  const messages: Record<string, unknown>[] = [];
  const revoked: string[] = [];
  const delegation = new Delegation({
    registry,
    children,
    log: () => undefined,
    announce: (m) => void messages.push(m),
    closeTab: async (tab) => void registry.remove(tab.sessionId),
    notify: (title, body) => void notes.push(`${title}|${body}`),
    revoke: (id) => void revoked.push(id),
    quietMs,
  });
  const writes = new Map<string, string[]>();
  const open = (sessionId: string, title: string, dirs: string[] = ['/a'], lineage = {}): Tab => {
    const log: string[] = [];
    writes.set(sessionId, log);
    const handle = { id: 1, pid: 1, write: async (d: string) => void log.push(d), resize: async () => undefined, kill: async () => undefined, onExit: () => ({ dispose() {} }), share: async () => 't' } as unknown as PtyHandle;
    const tab: Tab = { sessionId, doc: `d-${sessionId}`, title, agent: 'agent-claude-code', dirs, handle };
    registry.add(tab);
    delegation.attach(tab, lineage);
    return tab;
  };
  const feed = (tab: Tab, ...events: AgentEvent[]): void => events.forEach((e) => delegation.event(tab, e));
  return { registry, delegation, children, stored, notes, messages, revoked, writes, open, feed };
}

const peerOf = (r: ReturnType<typeof rig>, caller: number, id: number) => r.delegation.peers(caller)?.find((p) => p.id === id);

test('состояние по событиям агента: starting до начала сессии, работа, конец хода, вопрос, фоновая работа', () => {
  const r = rig();
  const tab = r.open('s1', 'Claude Code 1');
  assert.equal(peerOf(r, 1, 1)?.state, 'starting');
  r.feed(tab, { type: 'session', resumeId: A });
  assert.equal(peerOf(r, 1, 1)?.state, 'waiting', 'SessionStart: CC загрузился и ждёт');
  r.feed(tab, { type: 'prompt' });
  assert.equal(peerOf(r, 1, 1)?.state, 'working');
  r.feed(tab, { type: 'turnEnd', background: true, text: 'ещё работаю' });
  assert.equal(peerOf(r, 1, 1)?.state, 'working', 'Stop с фоновыми задачами ход не кончает');
  r.feed(tab, { type: 'activity', tool: 'Bash' }, { type: 'turnEnd', background: false, text: 'итог хода' });
  assert.deepEqual([peerOf(r, 1, 1)?.state, peerOf(r, 1, 1)?.lastAnswer], ['waiting', 'итог хода']);
  r.feed(tab, { type: 'waiting', reason: 'Ход завершён, ждёт ответа' });
  assert.equal(peerOf(r, 1, 1)?.state, 'waiting', 'то же «ждёт», объявленное после тишины, вопросом к человеку не становится');
  r.feed(tab, { type: 'prompt' }, { type: 'waiting', reason: 'Просит разрешение' });
  assert.deepEqual([peerOf(r, 1, 1)?.state, peerOf(r, 1, 1)?.reason], ['asking', 'Просит разрешение']);
  r.feed(tab, { type: 'activity' });
  assert.deepEqual([peerOf(r, 1, 1)?.state, peerOf(r, 1, 1)?.reason], ['working', undefined], 'работа снимает причину');
  r.feed(tab, { type: 'cwd', cwd: '/b' });
  assert.equal(peerOf(r, 1, 1)?.cwd, '/b');
});

test('номера: из заголовка вкладки, занятый - следующий; peers - вкладки того же проекта, без вышедших', () => {
  const r = rig();
  const a = r.open('s1', 'Claude Code 1', ['/a', '/b']);
  r.open('s2', 'Claude Code 2', ['/b', '/a']);
  r.open('s3', 'Claude Code 3', ['/c']);
  r.open('s4', 'Claude Code 3', ['/a', '/b']);
  assert.deepEqual([1, 2, 3, 4].map((n) => r.delegation.sessionOf(n)), ['s1', 's2', 's3', 's4'], 'повтор заголовка получает следующий номер');
  assert.deepEqual(r.delegation.peers(1)?.map((p) => p.id), [1, 2, 4], 'проект - набор каталогов запуска, порядок не важен');
  assert.deepEqual(r.delegation.peers(3)?.map((p) => p.id), [3]);
  r.registry.ended('s2');
  r.delegation.forget('s2');
  assert.deepEqual(r.delegation.peers(1)?.map((p) => p.id), [1, 4]);
  assert.equal(r.delegation.peers(2), null, 'у вышедшей сессии перечня нет');
  assert.deepEqual(r.revoked, ['s2'], 'токен вышедшей отозван');
  assert.equal(a.sessionId, 's1');
});

test('родитель и семья: дочерняя берёт семью родителя, самостоятельная - свою; подпись CC2 ↳1', () => {
  const r = rig();
  r.open('s1', 'Claude Code 1');
  r.open('s2', 'Claude Code 2', ['/a'], r.delegation.lineageOf('s1'));
  r.open('s3', 'Claude Code 3', ['/a'], r.delegation.lineageOf('s2'));
  r.open('s4', 'Claude Code 4');
  assert.deepEqual(r.delegation.family().map((f) => [f.label, f.family]), [
    ['CC1', 's1'],
    ['CC2 ↳1', 's1'],
    ['CC3 ↳2', 's1'],
    ['CC4', 's4'],
  ]);
  const peers = r.delegation.peers(1) ?? [];
  assert.equal(peers.find((p) => p.id === 2)?.parent, 1);
  assert.equal('parent' in (peers.find((p) => p.id === 1) ?? {}), false);
  assert.deepEqual([1, 2, 3, 4].map((n) => r.delegation.isChild(n)), [false, true, true, false]);
  // Родитель закрыт: подпись и семья остаются у дочерней.
  r.delegation.forget('s1');
  assert.equal(r.delegation.family().find((f) => f.sessionId === 's2')?.label, 'CC2 ↳1');
});

test('перечень дочерних разговоров: первое событие и новый разговор после /clear дочерней; у самостоятельной - нет', async () => {
  const r = rig();
  const own = r.open('s1', 'Claude Code 1');
  const child = r.open('s2', 'Claude Code 2', ['/a'], r.delegation.lineageOf('s1'));
  r.feed(own, { type: 'session', resumeId: A });
  r.feed(child, { type: 'session', resumeId: B }, { type: 'session', resumeId: B });
  assert.deepEqual([...(await r.children.all())], [B]);
});

test('say: ждущей сессии - вставкой и Enter отдельной записью; запуск, вопрос и завершённая сессия - отказ', async () => {
  const r = rig();
  const tab = r.open('s1', 'Claude Code 1');
  await assert.rejects(r.delegation.say(1, 'x'), /запускается/);
  r.feed(tab, { type: 'session', resumeId: A });
  assert.equal(await r.delegation.say(1, 'две\nстроки'), 'sent');
  assert.deepEqual(r.writes.get('s1'), ['\x1b[200~две\nстроки\x1b[201~', '\r']);
  r.feed(tab, { type: 'waiting', reason: 'Просит разрешение' });
  await assert.rejects(r.delegation.say(1, 'x'), /Просит разрешение/);
  await assert.rejects(r.delegation.say(101, 'x'), /завершилась/);
  assert.equal(r.writes.get('s1')?.length, 2);
});

test('say: работающей сессии - в очередь, по сообщению после конца хода; Stop с фоновыми задачами ход не кончает', async () => {
  const quiet = 200;
  const r = rig(quiet);
  const tab = r.open('s1', 'Claude Code 1');
  const writes = r.writes.get('s1') ?? [];
  r.feed(tab, { type: 'prompt' });
  assert.equal(await r.delegation.say(1, 'первое'), 'queued');
  assert.equal(await r.delegation.say(1, 'второе'), 'queued');
  assert.equal(peerOf(r, 1, 1)?.queued, 2);
  r.feed(tab, { type: 'turnEnd', background: true });
  await sleep(quiet + SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes, []);
  r.feed(tab, { type: 'turnEnd', background: false });
  await sleep(quiet + SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes, ['\x1b[200~первое\x1b[201~', '\r']);
  assert.equal(peerOf(r, 1, 1)?.queued, 1);
  // Отправленное начинает ход раньше, чем истечёт тишина после Enter: второе ждёт его конца.
  r.feed(tab, { type: 'prompt' });
  await sleep(quiet + 50);
  assert.equal(writes.length, 2);
  r.feed(tab, { type: 'turnEnd', background: false });
  await sleep(quiet + SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes.slice(2), ['\x1b[200~второе\x1b[201~', '\r']);
  assert.equal(peerOf(r, 1, 1)?.queued, 0);
});

test('say: после события сессия должна помолчать, иначе сообщение ждёт в очереди', async () => {
  const r = rig(300);
  const tab = r.open('s1', 'Claude Code 1');
  r.feed(tab, { type: 'session', resumeId: A });
  assert.equal(await r.delegation.say(1, 'x'), 'queued');
  assert.deepEqual(r.writes.get('s1'), []);
  await sleep(300 + SUBMIT_DELAY_MS + 100);
  assert.deepEqual(r.writes.get('s1'), ['\x1b[200~x\x1b[201~', '\r']);
});

test('say: сообщение во время отправки другого ждёт в очереди, вставки не перемешиваются', async () => {
  const r = rig();
  const tab = r.open('s1', 'Claude Code 1');
  r.feed(tab, { type: 'session', resumeId: A });
  const first = r.delegation.say(1, 'первое');
  assert.equal(await r.delegation.say(1, 'второе'), 'queued');
  assert.equal(await first, 'sent');
  await sleep(SUBMIT_DELAY_MS + 50);
  assert.deepEqual(r.writes.get('s1'), ['\x1b[200~первое\x1b[201~', '\r', '\x1b[200~второе\x1b[201~', '\r']);
});

test('enqueue: текст в обход validateSend вставляется без ESC, конец вставки не закрыть', async () => {
  const r = rig();
  const tab = r.open('s1', 'Claude Code 1');
  r.feed(tab, { type: 'session', resumeId: A });
  assert.equal(r.delegation.enqueue('s1', 'итог\x1b[201~\r!rm -rf ~'), true);
  assert.equal(r.delegation.enqueue('нет такой', 'x'), false);
  await sleep(SUBMIT_DELAY_MS + 50);
  assert.deepEqual(r.writes.get('s1'), ['\x1b[200~итог[201~\n!rm -rf ~\x1b[201~', '\r']);
});

test('say: сессия начала ход между вставкой и Enter - Enter не отправлен', async () => {
  const r = rig();
  const tab = r.open('s1', 'Claude Code 1');
  r.feed(tab, { type: 'session', resumeId: A });
  const pending = r.delegation.say(1, 'x');
  r.feed(tab, { type: 'waiting', reason: 'Просит разрешение' });
  await assert.rejects(pending, /Enter не отправлен/);
  assert.deepEqual(r.writes.get('s1'), ['\x1b[200~x\x1b[201~']);
});

test('закрытая вкладка забирает очередь: тайм-ер снят, сообщений не уходит', async () => {
  const r = rig(50);
  const tab = r.open('s1', 'Claude Code 1');
  r.feed(tab, { type: 'prompt' });
  assert.equal(await r.delegation.say(1, 'x'), 'queued');
  r.feed(tab, { type: 'turnEnd', background: false });
  await r.delegation.close(1);
  await sleep(50 + SUBMIT_DELAY_MS + 50);
  assert.deepEqual(r.writes.get('s1'), []);
  assert.deepEqual(r.messages, [{ type: 'session:close', sessionId: 's1', number: 1 }]);
  assert.deepEqual(r.revoked, []);
  await assert.rejects(r.delegation.close(1), /нет/);
});

test('reportLocal: итог - в очередь открывшей, один за круг; новый круг - после запроса; без открывшей - уведомление', async () => {
  const r = rig();
  const own = r.open('s1', 'Claude Code 1');
  const child = r.open('s2', 'Claude Code 2', ['/a'], r.delegation.lineageOf('s1'));
  r.feed(own, { type: 'session', resumeId: A });
  assert.throws(() => r.delegation.reportLocal(1, { status: 'ok', summary: 'x' }), /открытой другой сессией/);
  assert.match(r.delegation.reportLocal(2, { status: 'ok', summary: 'сделано', branch: 'feat-x' }), /Итог принят/);
  assert.equal(peerOf(r, 1, 1)?.queued, 1);
  assert.throws(() => r.delegation.reportLocal(2, { status: 'ok', summary: 'ещё' }), /уже отправлен/);
  await sleep(SUBMIT_DELAY_MS + 50);
  assert.deepEqual(r.writes.get('s1'), ['\x1b[200~Итог сессии CC2: ok\nветка: feat-x\n\nсделано\x1b[201~', '\r']);
  r.feed(child, { type: 'prompt' });
  r.registry.ended('s1');
  r.delegation.forget('s1');
  assert.match(r.delegation.reportLocal(2, { status: 'blocked', summary: 'нужен человек' }), /Итог принят/);
  assert.deepEqual(r.notes, ['CC2|blocked: нужен человек']);
});

test('кнопки инструмента поставщика: хранятся до запроса человека и уходят виду', () => {
  const r = rig();
  const tab = r.open('s1', 'Claude Code 1');
  r.delegation.setActions('s1', [{ label: 'Дальше', text: 'продолжай' }]);
  assert.deepEqual(r.delegation.actionsOf('s1'), [{ label: 'Дальше', text: 'продолжай' }]);
  r.feed(tab, { type: 'prompt' });
  assert.deepEqual(r.delegation.actionsOf('s1'), []);
  assert.deepEqual(r.messages, [
    { type: 'actions', sessionId: 's1', actions: [{ label: 'Дальше', text: 'продолжай' }] },
    { type: 'actions', sessionId: 's1', actions: [] },
  ]);
});

test('по умолчанию сессия должна помолчать 2 с, как в ai-cyborg', () => {
  assert.equal(OUTBOX_QUIET_MS, 2000);
});
