// Главная часть для видов: `sessions.tabs`, закрытие вкладки, команды путей, ссылок и буфера обмена, история проекта, толчки каналом, заголовок окна.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { until } from './dom.ts';
import { rig, settle, writeJournal, UUID_A } from './kit.ts';
import type { TabInfo } from '../tab-info.ts';

interface Row {
  id: string;
  repo: string;
  agent: string;
  title: string;
  updated: number;
}

const types = (r: { sent: { view: string; message: unknown }[] }, view: string): string[] => r.sent.filter((m) => m.view === view).map((m) => String((m.message as { type?: string }).type ?? Object.keys(m.message as object)[0]));

test('sessions.tabs: состояние, каталог, метки и заголовок вкладок в памяти; вкладка прошлого запуска помечена; закрытая вкладка исчезает вместе с документом', async () => {
  await using r = await rig();
  const first = await r.sessions.create({ cwd: r.repoA, addDirs: [r.repoB] });
  const proc = r.last();
  let tabs = (await r.run('sessions.tabs')) as TabInfo[];
  assert.equal(tabs.length, 1);
  assert.deepEqual(tabs[0], { doc: r.kernel.documents[0]?.id, sessionId: first.sessionId, title: 'Claude Code 1', agent: 'agent-claude-code', cwd: r.repoA, state: 'starting', labels: {}, previous: false });
  await r.armed(proc);
  await r.hook(proc, { hook_event_name: 'PostToolUse', cwd: '/moved', tool_name: 'EnterWorktree' });
  await r.hook(proc, { hook_event_name: 'Notification', notification_type: 'agent_needs_input' });
  await until(async () => ((await r.run('sessions.tabs')) as TabInfo[])[0]?.state === 'waiting', 'ждёт');
  tabs = (await r.run('sessions.tabs')) as TabInfo[];
  assert.equal(tabs[0]?.cwd, '/moved', 'текущий каталог идёт за событием cwd');
  assert.equal(tabs[0]?.reason, 'Ждёт ответа');
  await r.sessions.setLabels(first.sessionId, { task: { key: 'p1#1', title: '#1 Задача', status: 'закрыта' } });
  assert.equal(((await r.run('sessions.tabs')) as TabInfo[])[0]?.title, 'Claude Code 1 · #1 Задача · закрыта');
  proc.exit(0);
  await until(async () => ((await r.run('sessions.tabs')) as TabInfo[])[0]?.state === 'exited', 'вышла');
  assert.deepEqual(((await r.run('sessions.tabs')) as TabInfo[])[0]?.labels, {}, 'выход снял привязку');
  assert.ok(!('reason' in (((await r.run('sessions.tabs')) as TabInfo[])[0] ?? {})));
  // закрытие вкладки командой: документ убран, метки и сессия забыты, вид получил толчок
  const doc = r.kernel.documents[0]?.id;
  assert.ok(doc);
  const before = types(r, 'main').length;
  await r.run('sessions.close-tab', doc);
  assert.equal(r.kernel.documents.length, 0);
  assert.deepEqual(await r.run('sessions.tabs'), []);
  assert.ok(types(r, 'main').slice(before).includes('tabs'));
  await assert.rejects(r.sessions.reveal(first.sessionId), /вкладки нет/);
  // закрытая вкладка работающей сессии завершает процесс
  await r.sessions.create({ cwd: r.repoB });
  const second = r.last();
  const secondDoc = r.kernel.documents[0]?.id;
  assert.ok(secondDoc);
  await r.run('sessions.close-tab', secondDoc);
  assert.equal(second.killed, 'SIGHUP');
});

test('reveal просит вид показать вкладку; новая сессия, команда сочетания клавиш и смена проекта толкают виды', async () => {
  await using r = await rig();
  const { sessionId } = await r.sessions.create({ cwd: r.repoA });
  await r.sessions.reveal(sessionId);
  const doc = r.kernel.documents[0]?.id;
  assert.ok(r.sent.some((m) => m.view === 'main' && JSON.stringify(m.message) === JSON.stringify({ type: 'reveal', doc })));
  await r.run('sessions.new-request');
  await r.run('sessions.font-reset');
  assert.deepEqual(types(r, 'main').filter((t) => t === 'new-session' || t === 'font-reset'), ['new-session', 'font-reset']);
  // выбранный проект сменился: вид «Сессии проекта» перечитывает историю
  const before = r.sent.filter((m) => m.view === 'history').length;
  r.projects.select('Другой');
  await until(() => r.sent.filter((m) => m.view === 'history').length > before, 'толчок виду истории');
});

test('заголовок окна: фрагмент плагина - название выбранного проекта, снятый выбор снимает фрагмент (FR-10005, title)', async () => {
  await using r = await rig({ load: {} });
  await until(() => r.kernel.window.title.includes('Проект'), 'название проекта в заголовке');
  assert.match(r.kernel.window.title, /^Проект - /);
  r.projects.select('Маркетплейс');
  await until(() => r.kernel.window.title.startsWith('Маркетплейс - '), 'название сменилось');
  r.projects.select(null);
  await until(() => !r.kernel.window.title.includes('Маркетплейс'), 'фрагмент снят');
  assert.doesNotMatch(r.kernel.window.title, /Проект/);
});

test('sessions.history.list: история всех агентов по репозиториям проекта, свежие первыми; чужой проект и негодный аргумент - отказ', async () => {
  await using r = await rig();
  await writeJournal(r, r.repoA, UUID_A, 'в первом');
  await writeJournal(r, r.repoB, '22222222-2222-2222-2222-222222222222', 'во втором');
  const list = (await r.run('sessions.history.list', 'p1')) as Row[];
  assert.deepEqual(list.map((x) => [x.title, x.agent, x.repo]).toSorted(), [['в первом', 'agent-claude-code', r.repoA], ['во втором', 'agent-claude-code', r.repoB]].toSorted());
  assert.ok(list.every((x, i) => i === 0 || (list[i - 1]?.updated ?? 0) >= x.updated));
  await assert.rejects(r.run('sessions.history.list', 'нет-такого'), /Проект не найден/);
});

test('sessions.history.delete: репозиторий вне проекта, негодные id и незнакомый агент отвергаются до агента; удаление идёт только по репозиторию проекта', async () => {
  await using r = await rig();
  await writeJournal(r, r.repoA, UUID_A);
  await assert.rejects(r.run('sessions.history.delete', 'p1', '/etc', [UUID_A], 'agent-claude-code'), /Некорректное удаление/);
  await assert.rejects(r.run('sessions.history.delete', 'p1', r.repoA, ['../x'], 'agent-claude-code'), /Некорректное удаление/);
  await assert.rejects(r.run('sessions.history.delete', 'p1', r.repoA, [UUID_A], 'agent-shell'), /агента agent-shell нет/);
  await assert.rejects(r.run('sessions.history.delete', 'нет', r.repoA, [UUID_A], 'agent-claude-code'), /Проект не найден/);
  assert.equal(((await r.run('sessions.history.list', 'p1')) as Row[]).length, 1, 'ничего не стёрто');
  assert.deepEqual(await r.run('sessions.history.delete', 'p1', r.repoA, [UUID_A], 'agent-claude-code'), { deleted: [UUID_A], failed: [] });
});

test('sessions.open-path и open-url: форма проверяется до ядра, без права в среде - понятный отказ; sessions.copy ограничен по размеру', async () => {
  await using r = await rig();
  await assert.rejects(r.run('sessions.open-path', 'a/b.png'), /не абсолютный/);
  await assert.rejects(r.run('sessions.open-path', '/a/../b'), /«\.\.»/);
  await assert.rejects(r.run('sessions.open-url', 'file:///etc/passwd'), /только ссылки http и https/);
  await assert.rejects(r.run('sessions.open-url', 'ftp://x'), /только ссылки http и https/);
  await assert.rejects(r.run('sessions.copy', 'x'.repeat(4 * 1024 * 1024 + 1)), /до 4 МиБ/);
  await settle(20);
  assert.ok(!r.kernel.journal.some((e) => e.kind === 'failed'));
});
