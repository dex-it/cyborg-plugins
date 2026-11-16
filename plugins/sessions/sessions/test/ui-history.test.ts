// Вид «Сессии проекта» (FR-8001..8005): список прошлых сессий выбранного проекта, продолжение щелчком, выделение, удаление одной и нескольких, диалоги слоя ядра.
// История берётся у `agent-claude-code` (журналы в подставном каталоге настроек Claude), удаление идёт его командой `history.delete`.
import assert from 'node:assert/strict';
import { access, utimes } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { mountHistory } from '../ui/history.ts';
import { FakeElement, until, withDocument } from './dom.ts';
import { rig, writeJournal, UUID_A, UUID_B, type Rig } from './kit.ts';
import { asRoot, titleOf, uiRig } from './ui-kit.ts';

const UUID_C = '33333333-3333-3333-3333-333333333333';
const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false);

async function seed(r: Rig): Promise<void> {
  await writeJournal(r, r.repoA, UUID_A, 'почини тесты');
  await writeJournal(r, r.repoA, UUID_B, 'дерево файлов');
  await writeJournal(r, r.repoB, UUID_C, 'другой репозиторий');
  // время правки журнала = «обновлена»: свежие первыми
  const stamp = Date.now() / 1000;
  await utimes(path.join(r.journalDir(r.repoA), `${UUID_A}.jsonl`), stamp - 300, stamp - 300);
  await utimes(path.join(r.journalDir(r.repoA), `${UUID_B}.jsonl`), stamp - 100, stamp - 100);
  await utimes(path.join(r.journalDir(r.repoB), `${UUID_C}.jsonl`), stamp - 3600 * 5, stamp - 3600 * 5);
}

async function viewOf<T>(r: Rig, body: (root: FakeElement, ui: ReturnType<typeof uiRig>) => Promise<T>): Promise<T> {
  return withDocument(async () => {
    const root = new FakeElement('div');
    const ui = uiRig(r, 'history');
    const view = mountHistory(asRoot(root), ui.ctx, { commandKey: (e) => e.ctrlKey });
    try {
      return await body(root, ui);
    } finally {
      view.dispose();
      ui.dispose();
    }
  });
}

const rows = (root: FakeElement): FakeElement[] => root.byClass('history-item');
const titles = (root: FakeElement): string[] => rows(root).map((row) => row.byClass('history-title')[0]?.textContent ?? '');
const click = (row: FakeElement | undefined, extra: Record<string, unknown> = {}): void => void row?.fire('click', { shiftKey: false, ctrlKey: false, ...extra });

describe('вид «Сессии проекта»', () => {
  it('нет проекта и нет сессий - подсказки; список по всем репозиториям проекта, свежие первыми, с давностью и репозиторием', async () => {
    await using r = await rig();
    await viewOf(r, async (root) => {
      await until(() => root.find('note').textContent === 'Прошлых сессий нет', 'пустой список');
    });
    await seed(r);
    await viewOf(r, async (root) => {
      await until(() => rows(root).length === 3, 'три сессии');
      assert.deepEqual(titles(root), ['дерево файлов', 'почини тесты', 'другой репозиторий']);
      assert.match(rows(root)[0]?.byClass('repo-path')[0]?.textContent ?? '', /^repo-a · (только что|1 мин|2 мин)/);
      assert.match(rows(root)[2]?.byClass('repo-path')[0]?.textContent ?? '', /^repo-b · 5 ч/);
      assert.equal(rows(root)[0]?.getAttribute('role'), 'option');
      assert.equal(root.find('history').getAttribute('aria-multiselectable'), 'true');
      assert.deepEqual(rows(root).map((x) => x.tabIndex), [0, -1, -1], 'в порядке табуляции одна запись');
    });
    r.projects.select(null);
    await viewOf(r, async (root) => {
      await until(() => root.find('note').textContent === 'Нет проекта', 'нет проекта');
    });
  });

  it('щелчок продолжает сессию: новая вкладка с --resume, дополнительные каталоги - остальные репозитории проекта; отказ - диалог слоя ядра', async () => {
    await using r = await rig();
    await seed(r);
    await viewOf(r, async (root, ui) => {
      await until(() => rows(root).length === 3, 'список');
      click(rows(root)[1]);
      await until(() => r.pty.procs.length === 1, 'сессия запущена');
      assert.deepEqual(r.last().args.slice(3, 5), ['--resume', UUID_A]);
      assert.deepEqual(r.last().args.slice(-2), ['--add-dir', r.repoB]);
      assert.equal(r.last().options.cwd, r.repoA);
      // главная часть просит вид «Сессии» показать новую вкладку
      await until(() => r.sent.some((m) => m.view === 'main' && (m.message as { type?: string }).type === 'reveal'), 'вид «Сессии» получил просьбу показать вкладку');
      // репозиторий убран из проекта: продолжение отвергнуто с причиной в диалоге
      r.projects.repos = [r.repoB];
      click(rows(root)[0]);
      assert.equal(titleOf(await ui.answer('ok')), 'Сессия не продолжена');
      assert.equal(r.pty.procs.length, 1);
    });
  });

  it('выделение: Ctrl или Cmd + щелчок, Shift + щелчок диапазоном, флажок; пока что-то выделено, щелчок не продолжает сессию; «Все», «Отмена», Escape', async () => {
    await using r = await rig();
    await seed(r);
    await viewOf(r, async (root) => {
      await until(() => rows(root).length === 3, 'список');
      assert.equal(root.find('selection').hidden, true);
      click(rows(root)[0], { ctrlKey: true });
      assert.equal(root.find('selection').hidden, false);
      assert.equal(root.find('count').textContent, 'Выбрано: 1');
      click(rows(root)[2], { shiftKey: true });
      assert.equal(root.find('count').textContent, 'Выбрано: 3', 'диапазон от опорной записи');
      click(rows(root)[1]);
      assert.equal(root.find('count').textContent, 'Выбрано: 2', 'щелчок посреди отбора переключает запись, сессия не стартует');
      assert.equal(r.pty.procs.length, 0);
      assert.equal(rows(root)[1]?.getAttribute('aria-selected'), 'false');
      root.find('select-all').fire('click');
      assert.equal(root.find('count').textContent, 'Выбрано: 3');
      root.find('cancel').fire('click');
      assert.equal(root.find('selection').hidden, true);
      click(rows(root)[0], { ctrlKey: true });
      rows(root)[0]?.fire('keydown', { key: 'Escape' });
      assert.equal(root.find('selection').hidden, true, 'Escape снимает выделение');
    });
  });

  it('удаление одной сессии: вопрос слоя ядра, отмена оставляет журнал, согласие стирает его; Delete на записи то же', async () => {
    await using r = await rig();
    await seed(r);
    const journal = (id: string): string => path.join(r.journalDir(r.repoA), `${id}.jsonl`);
    await viewOf(r, async (root, ui) => {
      await until(() => rows(root).length === 3, 'список');
      (rows(root)[0]?.byClass('close')[0] as FakeElement).fire('click');
      assert.equal(titleOf(await ui.answer('no')), 'Удалить сессию');
      assert.ok(await exists(journal(UUID_B)), 'отмена: журнал на месте');
      (rows(root)[0]?.byClass('close')[0] as FakeElement).fire('click');
      await ui.answer('yes');
      await until(() => rows(root).length === 2, 'запись убрана');
      assert.ok(!(await exists(journal(UUID_B))), 'журнал стёрт');
      assert.deepEqual(titles(root), ['почини тесты', 'другой репозиторий']);
      // Delete на записи
      rows(root)[0]?.fire('keydown', { key: 'Delete' });
      await ui.answer('yes');
      await until(() => rows(root).length === 1, 'вторая запись убрана');
      assert.ok(!(await exists(journal(UUID_A))));
    });
  });

  it('удаление нескольких разом: счёт «2 сессии» в вопросе, удалены выбранные, остальные на месте (FR-8005); отказ агента перечислен диалогом', async () => {
    await using r = await rig();
    await seed(r);
    await viewOf(r, async (root, ui) => {
      await until(() => rows(root).length === 3, 'список');
      click(rows(root)[0], { ctrlKey: true });
      click(rows(root)[2], { ctrlKey: true });
      root.find('remove-selected').fire('click');
      const spec = await ui.dialog();
      assert.equal(titleOf(spec.spec), 'Удалить сессии');
      assert.match(spec.spec.kind === 'ask' ? (spec.spec.message ?? '') : '', /Удалить 2 сессии\?/);
      r.kernel.answerDialog(spec.id, 'yes');
      await until(() => rows(root).length === 1, 'остались невыбранные');
      assert.deepEqual(titles(root), ['почини тесты']);
      assert.equal(root.find('selection').hidden, true);
      assert.ok(await exists(path.join(r.journalDir(r.repoA), `${UUID_A}.jsonl`)));
      assert.ok(!(await exists(path.join(r.journalDir(r.repoB), `${UUID_C}.jsonl`))));
      // журнал уже стёрт, а запись ещё в списке: агент отвечает отказом по этой сессии, остальные продолжаются
      click(rows(root)[0], { ctrlKey: true });
      await (await import('node:fs/promises')).rm(path.join(r.journalDir(r.repoA), `${UUID_A}.jsonl`));
      root.find('remove-selected').fire('click');
      await ui.answer('yes');
      assert.equal(titleOf((await ui.dialog()).spec), 'Не удалось удалить');
    });
  });
});
