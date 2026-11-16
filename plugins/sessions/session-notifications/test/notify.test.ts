import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LayerStore } from '@cyborg-harness/core';
import { memoryStore, startKernel } from '@cyborg-harness/testing';
import { HOME, activity, exited, fakeNotify, fakeSessions, rig, settle, waiting, waitFor } from './rig.ts';

// Перенос test/notify.test.ts ai-cyborg (WaitNotifier) и сценария FR-10006: тот же набор утверждений на настоящем ядре тест-кита.
// Источник «ждёт» - подставной поставщик cyborg.sessions (настоящего sessions в репозитории ещё нет), показ - подставная среда уведомлений ядра.

const menuOf = (r: Awaited<ReturnType<typeof rig>>) => r.k.menus.find((m) => m.pluginId === 'session-notifications' && m.id === 'toggle');

describe('уведомления о ждущих сессиях', () => {
  it('по умолчанию включён и сообщает состояние меню при старте', async () => {
    await using r = await rig();
    await waitFor('галочка вернулась', () => menuOf(r)?.checked === true);
    assert.equal(menuOf(r)?.enabled, true);
  });

  it('сессия переходит в «ждёт» - уведомление одно: заголовок - подпись сессии, текст - причина', async () => {
    await using r = await rig();
    r.sessions.emit(waiting('s1', 'Просит разрешение'));
    await waitFor('уведомление показано', () => r.notices.shown.length === 1);
    await settle();
    assert.equal(r.notices.shown.length, 1, 'ровно одно');
    assert.deepEqual([r.notices.shown[0]!.title, r.notices.shown[0]!.body, r.notices.shown[0]!.closed], ['Claude Code s1 · проект', 'Просит разрешение', false]);
  });

  it('выход из состояния «ждёт» снимает уведомление: новая работа сессии и её выход', async () => {
    await using r = await rig();
    r.sessions.emit(waiting('s1'));
    r.sessions.emit(waiting('s2'));
    await waitFor('два уведомления', () => r.notices.shown.length === 2);
    const of = (id: string) => r.notices.shown.find((n) => n.title.includes(id))!;
    r.sessions.emit(activity('s1'));
    await waitFor('работа снимает уведомление s1', () => of('s1').closed);
    assert.equal(of('s2').closed, false, 'чужая сессия не затронута');
    r.sessions.emit(exited('s2', 3));
    await waitFor('выход снимает уведомление s2', () => of('s2').closed);
  });

  it('гасит только показанное и только раз: «работает» без «ждёт» и повторное «работает» ничего не закрывают', async () => {
    await using r = await rig();
    r.sessions.emit(activity('s1'));
    r.sessions.emit(waiting('s1'));
    await waitFor('показано', () => r.notices.shown.length === 1);
    r.sessions.emit(activity('s1'));
    r.sessions.emit(activity('s1'));
    r.sessions.emit(exited('s1'));
    await waitFor('закрыто', () => r.notices.shown[0]!.closed);
    await settle();
    assert.deepEqual(r.notices.shown.map((n) => n.closed), [true], 'ни нового показа, ни повторного закрытия');
  });

  it('новое «ждёт» у той же сессии заменяет прежнее уведомление, а не накапливает', async () => {
    await using r = await rig();
    r.sessions.emit(waiting('s1', 'Просит разрешение'));
    await waitFor('первое', () => r.notices.shown.length === 1);
    r.sessions.emit(waiting('s1', 'Ждёт ответа'));
    await waitFor('второе', () => r.notices.shown.length === 2);
    assert.deepEqual(r.notices.shown.map((n) => [n.body, n.closed]), [['Просит разрешение', true], ['Ждёт ответа', false]]);
  });

  it('уведомляет о сессии, когда окно без фокуса, и молчит, пока окно перед глазами', async () => {
    await using r = await rig({ windowFocused: () => true });
    r.sessions.emit(waiting('s1'));
    await waitFor('плагин разобрал событие', () => r.logs.some((l) => l.includes('окно в фокусе')));
    assert.equal(r.notices.shown.length, 0);
    r.k.emit({ kind: 'focus', focused: false });
    r.sessions.emit(waiting('s2'));
    await waitFor('показано', () => r.notices.shown.length === 1);
    assert.match(r.notices.shown[0]!.title, /s2/);
    // Фокус ушёл и вернулся до события: уведомления нет (гонка).
    r.k.emit({ kind: 'focus', focused: true });
    r.sessions.emit(waiting('s3'));
    await waitFor('второе событие в фокусе', () => r.logs.filter((l) => l.includes('окно в фокусе')).length === 2);
    assert.equal(r.notices.shown.length, 1);
  });

  it('выключенный не уведомляет и гасит показанные; выключатель действует без перезапуска', async () => {
    await using r = await rig();
    r.sessions.emit(waiting('s1'));
    await waitFor('показано', () => r.notices.shown.length === 1);
    await r.k.run('session-notifications.toggle', false);
    assert.equal(r.notices.shown[0]!.closed, true, 'показанные погашены');
    await waitFor('галочка снята', () => menuOf(r)?.checked === false);
    r.sessions.emit(waiting('s2'));
    await settle();
    assert.equal(r.notices.shown.length, 1, 'выключенный не уведомляет');
    await r.k.run('session-notifications.toggle');
    await waitFor('галочка вернулась', () => menuOf(r)?.checked === true);
    r.sessions.emit(waiting('s2'));
    await waitFor('включён обратно - уведомление пришло без перезапуска', () => r.notices.shown.length === 2);
  });

  it('выключатель переживает перезапуск: выключенный остаётся выключенным', async () => {
    const { store, docs } = memoryStore();
    {
      await using r = await rig({ state: store });
      await r.k.run('session-notifications.toggle', false);
    }
    assert.deepEqual(docs.get('workspace')?.['session-notifications'], { $version: 1, enabled: false });
    await using restarted = await rig({ state: store });
    assert.equal(menuOf(restarted)?.checked, false, 'меню читает сохранённое состояние');
    restarted.sessions.emit(waiting('s3'));
    await waitFor('событие разобрано', () => restarted.sessions.listeners() > 0);
    await settle();
    assert.equal(restarted.notices.shown.length, 0);
    await restarted.k.run('session-notifications.toggle', true);
    restarted.sessions.emit(waiting('s3'));
    await waitFor('включённый снова уведомляет', () => restarted.notices.shown.length === 1);
  });

  it('недоступное хранилище: плагин включён, переключение действует до выгрузки, запись не удалась - строка в журнале', async () => {
    const broken: LayerStore = {
      load: () => Promise.resolve(undefined),
      save: () => Promise.reject(new Error('нет места')),
      update: () => Promise.reject(new Error('нет места')),
    };
    await using r = await rig({ state: broken });
    await waitFor('галочка вернулась', () => menuOf(r)?.checked === true);
    await r.k.run('session-notifications.toggle', false);
    await waitFor('галочка снята', () => menuOf(r)?.checked === false);
    r.sessions.emit(waiting('s1'));
    await settle();
    assert.equal(r.notices.shown.length, 0);
    assert.ok(r.logs.some((l) => l.includes('выбор не сохранён')), JSON.stringify(r.logs));
  });

  it('аргументы уведомления проверяются: управляющие символы убраны, длина обрезана, пустой заголовок - без уведомления', async () => {
    await using r = await rig();
    r.sessions.emit(waiting('s1', 'Просит\nразрешение\u001b[0m', 'CC\tодин\n' + 'я'.repeat(500)));
    await waitFor('показано', () => r.notices.shown.length === 1);
    const [n] = r.notices.shown;
    assert.equal(n!.title.length, 120);
    assert.ok(n!.title.endsWith('…') && n!.title.startsWith('CC один я'));
    assert.equal(n!.body, 'Просит разрешение [0m');
    r.sessions.emit(waiting('s2', 'x', '   '));
    await waitFor('отброшено', () => r.logs.some((l) => l.includes('недопустимыми аргументами')));
    assert.equal(r.notices.shown.length, 1);
  });

  it('клик по уведомлению: ядро поднимает окно и закрывает баннер, команда плагина открывает вкладку именно этой сессии (cyborg.sessions.reveal)', async () => {
    await using r = await rig();
    r.sessions.emit(waiting('s1'));
    r.sessions.emit(waiting('s2'));
    await waitFor('два уведомления', () => r.notices.shown.length === 2);
    r.notices.shown.find((n) => n.title.includes('s2'))!.events.click();
    await waitFor('команда клика выполнена', () => r.logs.some((l) => l.includes('открыта сессия s2')));
    assert.equal(r.notices.raised(), 1, 'клик просит приложение поднять и сфокусировать окно');
    assert.deepEqual(r.sessions.revealed, ['s2'], 'вкладка кликнутой сессии, а не соседней');
    assert.deepEqual(r.notices.shown.map((n) => n.closed), [false, true], 'клик закрывает своё уведомление, чужое живо');
  });

  it('поставщик sessions без reveal (1.0): клик поднимает окно, плагин пишет в журнал, что открыть вкладку нечем', async () => {
    const old = fakeSessions({ reveal: false, id: 'old-sessions' });
    await using r = await rig({ sessions: old });
    r.sessions.emit(waiting('s1'));
    await waitFor('показано', () => r.notices.shown.length === 1);
    r.notices.shown[0]!.events.click();
    await waitFor('команда клика выполнена', () => r.logs.some((l) => l.includes('s1') && l.includes('вкладку открыть нечем')));
    assert.equal(r.notices.raised(), 1);
    assert.deepEqual(old.revealed, []);
  });

  it('без права notify у плагина нет ctx.os.notify: он говорит об этом в журнале и ничего не показывает', async () => {
    await using r = await rig({ manifest: (m) => Object.fromEntries(Object.entries(m).filter(([key]) => key !== 'permissions')) });
    assert.ok(r.logs.some((l) => l.includes('нет права notify')));
    r.sessions.emit(waiting('s1'));
    await waitFor('плагин разобрал событие', () => r.logs.some((l) => l.includes('показывать нечем')));
    assert.equal(r.notices.shown.length, 0);
  });


  it('без поставщика cyborg.sessions плагин активен, меню на месте, показывать нечего', async () => {
    const notices = fakeNotify();
    await using k = await startKernel({ plugins: [HOME], os: notices.os, load: { windowFocused: () => false } });
    await k.waitForJournal({ kind: 'activated', pluginId: 'session-notifications' });
    assert.equal(k.menus.find((m) => m.pluginId === 'session-notifications')?.checked, true);
    assert.equal(notices.shown.length, 0);
  });
});
