// Вид «Сессии»: состояние и заголовок вкладки из меток (FR-1014, FR-2013), порядок, закрытие, клавиатура (tabs, reorder, neighbor, title, panel-return).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { until, type FakeElement } from './dom.ts';
import { rig, type Rig } from './kit.ts';
import { labelOf, mounted, titleOf } from './ui-kit.ts';

const task = (key: string, title: string, status = 'открыта') => ({ key, title, status, url: `https://tracker/${key}` });

describe('вид «Сессии»: состояние и заголовок вкладки из меток', () => {
  it('работает, ждёт, вышла: состояние на вкладке; метки собирают заголовок «CC1 · #7 Название · открыта» и подсказку, выход снимает привязку', async () => {
    await using r = await rig();
    const { sessionId } = await r.sessions.create({ cwd: r.repoA });
    const proc = r.last();
    await mounted(r, async (m) => {
      await until(() => m.tabs().length === 1, 'вкладка');
      const tab = m.tabs()[0] as FakeElement;
      await r.armed(proc);
      await r.hook(proc, { hook_event_name: 'PostToolUse', tool_name: 'Edit' });
      await until(() => tab.getAttribute('data-state') === 'working', 'работает');
      await r.hook(proc, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
      await until(() => tab.getAttribute('data-state') === 'waiting', 'ждёт');
      assert.match(tab.getAttribute('aria-label') ?? '', /ждёт: Просит разрешение/);
      // метки: заголовок и подсказка, кнопка возврата к списку
      await r.sessions.setLabels(sessionId, { task: task('p1#7', '#7 Дерево файлов') });
      await until(() => labelOf(tab) === 'Claude Code 1 · #7 Дерево файлов · открыта', 'заголовок задачи');
      assert.match(tab.title, /https:\/\/tracker\/p1#7/);
      assert.equal(tab.getAttribute('data-return'), 'К #7 в списке');
      await r.sessions.setLabels(sessionId, { mr: task('p1!3', '!3 Дерево', 'workflow::review, открыт') });
      await until(() => labelOf(tab) === 'Claude Code 1 · #7 Дерево файлов · открыта · !3 Дерево · workflow::review, открыт', 'заголовок задачи и MR');
      // выход: привязка снята, заголовок прежний, вкладка остаётся с предложением восстановить
      proc.exit(0);
      await until(() => tab.getAttribute('data-state') === 'exited', 'вышла');
      await until(() => labelOf(tab) === 'Claude Code 1', 'привязка снята');
      const notice = m.root.byClass('notice')[0] as FakeElement;
      assert.equal(notice.hidden, false);
      assert.match(notice.children[0]?.textContent ?? '', /Сессия завершена \(код 0\)/);
    });
    r.clean();
  });

  it('заголовок вкладки с метками собирается только в виде: документ окна его не получает', async () => {
    await using r = await rig();
    await r.sessions.create({ cwd: r.repoA, labels: { task: task('p1#7', '#7 Уник-название') } });
    await mounted(r, async (m) => {
      await until(() => m.tabs()[0] && labelOf(m.tabs()[0] as FakeElement).includes('Уник-название'), 'заголовок виден в виде');
      assert.ok(!JSON.stringify(r.kernel.documents).includes('Уник'));
    });
  });
});

describe('вид «Сессии»: порядок вкладок, закрытие, клавиатура', () => {
  const three = async (r: Rig): Promise<void> => {
    for (const cwd of [r.repoA, r.repoB, r.repoA]) await r.sessions.create({ cwd });
  };
  const drag = (from: FakeElement, to: FakeElement): void => {
    const dataTransfer = { setData() {}, effectAllowed: '', dropEffect: '' };
    from.fire('dragstart', { dataTransfer });
    to.fire('dragover', { dataTransfer });
    to.fire('drop', { dataTransfer });
    from.fire('dragend', { dataTransfer });
  };

  it('перетаскивание вкладки меняет порядок и запоминает его в памяти вида; после перезапуска вида порядок тот же', async () => {
    await using r = await rig();
    await three(r);
    let remembered: unknown;
    await mounted(r, async (m) => {
      await until(() => m.tabs().length === 3, 'три вкладки');
      assert.deepEqual(m.tabs().map(labelOf), ['Claude Code 1', 'Claude Code 2', 'Claude Code 3']);
      drag(m.tabs()[0] as FakeElement, m.tabs()[2] as FakeElement);
      assert.deepEqual(m.tabs().map(labelOf), ['Claude Code 2', 'Claude Code 3', 'Claude Code 1']);
      await until(() => m.ui.state.saved.length > 0, 'порядок записан в память вида');
      remembered = m.ui.state.value;
    });
    await mounted(
      r,
      async (m) => {
        await until(() => m.tabs().length === 3, 'три вкладки после перезапуска вида');
        assert.deepEqual(m.tabs().map(labelOf), ['Claude Code 2', 'Claude Code 3', 'Claude Code 1']);
      },
      { state: remembered },
    );
  });

  it('стрелки переводят фокус по вкладкам (tablist), выбранная вкладка одна в порядке табуляции', async () => {
    await using r = await rig();
    await three(r);
    await mounted(r, async (m) => {
      await until(() => m.tabs().length === 3, 'три вкладки');
      const [a, b, c] = m.tabs() as [FakeElement, FakeElement, FakeElement];
      assert.equal(m.root.find('strip').getAttribute('role'), 'tablist');
      assert.deepEqual([a, b, c].map((t) => t.tabIndex), [-1, -1, 0], 'выбрана последняя вкладка');
      const ev = a.fire('keydown', { key: 'ArrowRight' });
      assert.ok(ev.prevented);
      assert.equal(b.focused, 1);
      c.fire('keydown', { key: 'ArrowRight' });
      assert.equal(a.focused, 1, 'по кругу');
      b.fire('click');
      assert.deepEqual([a, b, c].map((t) => t.getAttribute('aria-selected')), ['false', 'true', 'false']);
    });
  });

  it('закрытие работающей сессии спрашивает слой ядра, вышедшей - нет; после закрытия выбирается сосед справа, у последней - слева', async () => {
    await using r = await rig();
    await three(r);
    await mounted(r, async (m) => {
      await until(() => m.tabs().length === 3, 'три вкладки');
      const [a, b, c] = m.tabs() as [FakeElement, FakeElement, FakeElement];
      b.fire('click');
      (b.byClass('close')[0] as FakeElement).fire('click');
      assert.equal(titleOf(await m.ui.answer('no')), 'Сессия ещё работает');
      assert.equal(m.tabs().length, 3, 'отмена: вкладка осталась, процесс жив');
      assert.equal(r.pty.procs[1]?.killed, undefined);
      (b.byClass('close')[0] as FakeElement).fire('click');
      await m.ui.answer('yes');
      await until(() => m.tabs().length === 2, 'вкладка закрыта');
      assert.equal(r.pty.procs[1]?.killed, 'SIGHUP', 'процесс завершён');
      assert.equal(c.getAttribute('aria-selected'), 'true', 'сосед справа');
      // последняя вкладка: сосед слева; процесс вышел сам - вопроса нет
      r.pty.procs[2]?.exit(0);
      await until(() => c.getAttribute('data-state') === 'exited', 'вышла');
      (c.byClass('close')[0] as FakeElement).fire('click');
      await until(() => m.tabs().length === 1, 'закрыта без вопроса');
      assert.equal(r.kernel.window.dialog, undefined);
      assert.equal(a.getAttribute('aria-selected'), 'true', 'сосед слева');
      assert.equal(r.kernel.documents.length, 1, 'документ закрытой вкладки убран из окна');
    });
  });
});
