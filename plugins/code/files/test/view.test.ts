// Вид «Дерево» на настоящем ядре с настоящими `files`, `git` и `projects` и подменённым DOM (test/dom.ts): роли и состояния ARIA (tree.test.ts ai-cyborg, FR-4006), клавиатура и возврат фокуса,
// клики, отметки git, ветка и её смена (FR-7005), строка дерева как источник перетаскивания (FR-3001), гонка клика и обновления (FR-4007). Настоящий фрейм, CSP и элементы cy-* проверяет окно приложения.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Disposable, UiContext } from '@cyborg-harness/contracts';
import { rowKey } from '../ui/tree-keys.ts';
import { FakeElement, until, withDocument } from './dom.ts';
import { asRoot, fakeSessions, files, repo, rig, uiRig, type Repo, type Rig, type UiRig } from './kit.ts';

interface Mounted {
  readonly root: FakeElement;
  readonly tree: FakeElement;
  readonly ui: UiRig;
  readonly view: Disposable;
  rows(): FakeElement[];
  row(title: string): FakeElement;
  rowByName(name: string, nth?: number): FakeElement;
  name(row: FakeElement): string;
  /** Клавиша на строке: событие keydown с всплытием к дереву. */
  press(row: FakeElement, key: string, extra?: Record<string, unknown>): { prevented: boolean };
  settle(): Promise<void>;
}

async function show(t: Rig, wrap?: (ctx: UiContext) => UiContext): Promise<Mounted> {
  const { mount } = await import('../ui/tree.ts');
  const root = new FakeElement('div');
  root.mounted = true;
  const ui = uiRig(t);
  const view = mount(asRoot(root), wrap ? wrap(ui.ctx) : ui.ctx);
  const tree = root.find('tree');
  const m: Mounted = {
    root,
    tree,
    ui,
    view,
    rows: () => tree.querySelectorAll('[role="treeitem"]'),
    row: (title) => {
      const found = m.rows().find((r) => r.title === title || r.title.startsWith(`${title}\n`));
      assert.ok(found, `строки «${title}» нет; есть: ${m.rows().map((r) => r.title.split('\n')[0]).join(', ')}`);
      return found;
    },
    rowByName: (name, nth = 0) => {
      const found = m.rows().filter((r) => m.name(r) === name)[nth];
      assert.ok(found, `строки с именем ${name} нет`);
      return found;
    },
    name: (row) => row.children.find((c) => c.classList.contains('name'))?.textContent ?? '',
    press: (row, key, extra = {}) => {
      const event = row.fire('keydown', { key, ...extra });
      return { prevented: event.prevented };
    },
    settle: async () => {
      await new Promise((r) => setTimeout(r, 20));
      await t.run('files.stats');
      await new Promise((r) => setTimeout(r, 20));
    },
  };
  await until(() => m.rows().length > 0 || (root.find('hint').hidden === false ? true : undefined), 'первый ответ получен');
  return m;
}

const sample = (r: Repo): void => files(r.dir, { 'a/c/deep.txt': 'd', 'a/x.txt': 'x', 'b/c/.keep': '', 'f.txt': 'f' });

describe('роли и состояния ARIA (FR-4006)', () => {
  it('контейнер - tree «Файлы»; корни, каталоги и файлы - treeitem с глубиной; aria-expanded у корней и каталогов, у файлов его нет', async () => {
    using r = repo();
    sample(r);
    await using t = await rig();
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const m = await show(t);
      assert.equal(m.tree.getAttribute('role'), 'tree');
      assert.equal(m.tree.getAttribute('aria-label'), 'Файлы');
      m.rowByName('a').click();
      await until(() => m.rows().some((x) => m.name(x) === 'x.txt'), 'каталог a раскрыт');
      for (const row of m.rows()) assert.equal(row.getAttribute('role'), 'treeitem', row.title);
      const rootRow = m.rows()[0];
      assert.equal(rootRow?.getAttribute('aria-level'), '1');
      assert.equal(rootRow?.getAttribute('aria-expanded'), 'true');
      assert.equal(m.rowByName('a').getAttribute('aria-level'), '2');
      assert.equal(m.rowByName('a').getAttribute('aria-expanded'), 'true');
      assert.equal(m.rowByName('b').getAttribute('aria-expanded'), 'false');
      assert.equal(m.rowByName('c').getAttribute('aria-level'), '3');
      assert.equal(m.rowByName('x.txt').getAttribute('aria-level'), '3');
      assert.equal(m.rowByName('x.txt').getAttribute('aria-expanded'), null);
      m.view.dispose();
    });
  });

  it('свёрнутый корень: aria-expanded=false, потомков нет; клик по строке корня разворачивает его', async () => {
    using a = repo();
    using b = repo({ files: { 'only.txt': 'o' } });
    sample(a);
    await using t = await rig();
    await t.setProject([a.dir, b.dir]);
    await withDocument(async () => {
      const m = await show(t);
      const second = m.row(b.dir);
      assert.equal(second.getAttribute('aria-expanded'), 'false');
      assert.equal(m.rows().some((x) => m.name(x) === 'only.txt'), false);
      second.click();
      await until(() => m.rows().some((x) => m.name(x) === 'only.txt'), 'второй корень раскрыт');
      assert.equal(m.row(b.dir).getAttribute('aria-expanded'), 'true');
      m.view.dispose();
    });
  });

  it('aria-selected: true у выбранного файла, false у остальных файлов, у каталогов нет; ключи строк уникальны и различают одноимённые пути в разных корнях', async () => {
    using a = repo();
    using b = repo();
    sample(a);
    sample(b);
    await using t = await rig();
    await t.setProject([a.dir, b.dir]);
    await withDocument(async () => {
      const m = await show(t);
      m.row(b.dir).click();
      await until(() => m.rows().filter((x) => m.name(x) === 'f.txt').length === 2, 'оба корня раскрыты');
      m.rowByName('f.txt', 0).click();
      await until(() => m.rowByName('f.txt', 0).getAttribute('aria-selected') === 'true', 'файл выбран');
      assert.equal(m.rowByName('f.txt', 1).getAttribute('aria-selected'), 'false');
      assert.equal(m.rowByName('a', 0).getAttribute('aria-selected'), null);
      m.rowByName('f.txt', 1).click();
      await until(() => m.rowByName('f.txt', 1).getAttribute('aria-selected') === 'true', 'выбран файл второго корня');
      assert.equal(m.rowByName('f.txt', 0).getAttribute('aria-selected'), 'false');
      const keys = m.rows().map((x) => x.dataset.key);
      assert.equal(new Set(keys).size, keys.length, 'ключи уникальны');
      assert.equal(m.rowByName('a', 0).dataset.key, rowKey(a.dir, 'a'));
      assert.equal(m.rowByName('a', 1).dataset.key, rowKey(b.dir, 'a'));
      assert.equal(m.rows()[0]?.dataset.key, rowKey(a.dir, ''));
      m.view.dispose();
    });
  });

  it('в порядке табуляции одна строка: выбранный файл, иначе первая', async () => {
    using r = repo();
    sample(r);
    await using t = await rig();
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const m = await show(t);
      assert.deepEqual(m.rows().map((x) => x.tabIndex), m.rows().map((_, i) => (i === 0 ? 0 : -1)));
      m.rowByName('f.txt').click();
      await until(() => m.rowByName('f.txt').getAttribute('aria-selected') === 'true', 'выбран');
      m.rowByName('a').click();
      await until(() => m.rows().some((x) => m.name(x) === 'x.txt'), 'a раскрыт');
      assert.equal(m.rows().filter((x) => x.tabIndex === 0).length, 1);
      assert.equal(m.rowByName('f.txt').tabIndex, 0, 'табуляция входит в дерево на выбранном файле');
      m.view.dispose();
    });
  });
});

describe('клавиатура дерева (FR-4006)', () => {
  it('стрелки, Home, End, вправо и влево раскрывают и сворачивают, Enter открывает файл; фокус остаётся на строке с тем же ключом после перерисовки', async () => {
    using r = repo();
    sample(r);
    await using t = await rig();
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const m = await show(t);
      const rootRow = m.rows()[0];
      assert.ok(rootRow);
      rootRow.focus();
      assert.equal(m.press(rootRow, 'ArrowDown').prevented, true);
      assert.equal(m.tree.contains(null), false);
      // фокус на первой записи каталога: a
      await until(() => m.rowByName('a').focused > 0, 'фокус на a');
      assert.equal(m.press(m.rowByName('a'), 'ArrowRight').prevented, true, 'вправо на свёрнутом каталоге раскрывает');
      await until(() => m.rows().some((x) => m.name(x) === 'x.txt'), 'a раскрыт');
      // после перерисовки фокус на той же строке (по ключу), а не сброшен
      assert.equal(m.rowByName('a').focused > 0 && m.rowByName('a') === (globalThis.document.activeElement as unknown as FakeElement), true);
      assert.equal(m.press(m.rowByName('a'), 'ArrowRight').prevented, true, 'на раскрытом - к первому потомку');
      assert.equal((globalThis.document.activeElement as unknown as FakeElement).dataset.key, rowKey(r.dir, 'a/c'));
      assert.equal(m.press(m.rowByName('c'), 'ArrowLeft').prevented, true, 'влево на свёрнутом - к родителю');
      assert.equal((globalThis.document.activeElement as unknown as FakeElement).dataset.key, rowKey(r.dir, 'a'));
      assert.equal(m.press(m.rowByName('a'), 'ArrowLeft').prevented, true, 'влево на раскрытом сворачивает');
      await until(() => !m.rows().some((x) => m.name(x) === 'x.txt'), 'a свёрнут');
      assert.equal((globalThis.document.activeElement as unknown as FakeElement).dataset.key, rowKey(r.dir, 'a'), 'фокус остался на a');
      assert.equal(m.press(m.rowByName('a'), 'End').prevented, true);
      assert.equal((globalThis.document.activeElement as unknown as FakeElement).dataset.key, m.rows().at(-1)?.dataset.key);
      assert.equal(m.press(m.rowByName('f.txt'), 'Home').prevented, true);
      assert.equal((globalThis.document.activeElement as unknown as FakeElement).dataset.key, rowKey(r.dir, ''));
      assert.equal(m.press(m.rowByName('f.txt'), 'Enter').prevented, true, 'Enter - то же, что клик: файл открыт');
      await until(() => t.viewer.opened.length === 1, 'просмотр получил файл');
      assert.deepEqual(t.viewer.opened, [`${r.dir}/f.txt`]);
      assert.equal(m.press(m.rowByName('f.txt'), 'Tab').prevented, false, 'Tab дереву не принадлежит');
      assert.equal(m.press(m.rowByName('f.txt'), 'ArrowDown', { ctrlKey: true }).prevented, false, 'сочетания с Ctrl не перехватываются');
      m.view.dispose();
    });
  });

  it('фокус на строке, которой больше нет: переходит к ближайшему родителю', async () => {
    using r = repo();
    sample(r);
    await using t = await rig();
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const m = await show(t);
      m.rowByName('a').click();
      await until(() => m.rows().some((x) => m.name(x) === 'c'), 'a раскрыт');
      m.rowByName('c').click();
      await until(() => m.rows().some((x) => m.name(x) === 'deep.txt'), 'a/c раскрыт');
      m.rowByName('deep.txt').focus();
      // каталог удалили снаружи: событие слежения доходит до вида сообщением
      const { rmSync } = await import('node:fs');
      rmSync(`${r.dir}/a/c`, { recursive: true });
      await until(() => !m.rows().some((x) => m.name(x) === 'deep.txt'), 'строка исчезла', 8000);
      const focused = globalThis.document.activeElement as unknown as FakeElement;
      assert.equal(focused.dataset.key, rowKey(r.dir, 'a'), 'ближайший родитель, а не первая строка');
      m.view.dispose();
    });
  });
});

describe('отметки git, ветка, число изменений', () => {
  it('изменённый, неотслеживаемый, удалённый файл и каталог с изменениями внутри; ±N и ветка в строке корня', async () => {
    using r = repo({ files: { 'a/x.txt': 'x\n', 'a/y.txt': 'y\n', 'gone.txt': 'g\n', 'clean.txt': 'c\n' } });
    r.write('a/x.txt', 'changed\n');
    r.write('new.txt');
    const { rmSync } = await import('node:fs');
    rmSync(`${r.dir}/gone.txt`);
    await using t = await rig();
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const m = await show(t);
      const badge = (row: FakeElement): string | undefined => row.children.find((c) => c.className.startsWith('badge'))?.textContent;
      await until(() => badge(m.rowByName('new.txt')) === 'U', 'отметки пришли');
      assert.equal(badge(m.rowByName('gone.txt')), 'D', 'удалённый файл на диске показан строкой');
      assert.equal(badge(m.rowByName('a')), '•', 'внутри каталога есть изменения');
      assert.equal(m.rowByName('clean.txt').children.some((c) => c.className.startsWith('badge')), false);
      m.rowByName('a').click();
      await until(() => m.rows().some((x) => m.name(x) === 'x.txt'), 'a раскрыт');
      assert.equal(badge(m.rowByName('x.txt')), 'M');
      const meta = m.rows()[0]?.children.find((c) => c.className === 'meta');
      assert.match(meta?.children.map((c) => c.textContent).join('') ?? '', /⎇ main.*±3/);
      m.view.dispose();
    });
  });

  it('правка файла, коммит и смена ветки снаружи доходят до вида без опроса: сообщение главной части, затем один запрос состояния', async () => {
    using r = repo({ files: { 'a.txt': 'a\n' }, branches: ['feature'] });
    await using t = await rig();
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const m = await show(t);
      const badge = (name: string): string | undefined => m.rowByName(name).children.find((c) => c.className.startsWith('badge'))?.textContent;
      const metaText = (): string => m.rows()[0]?.children.find((c) => c.className === 'meta')?.children.map((c) => c.textContent).join('') ?? '';
      // слежение за деревом и за .git начинает доставку позже возврата watch: правка повторяется, пока вид её не покажет
      for (let i = 0; i < 40 && badge('a.txt') !== 'M'; i++) {
        r.write('a.txt', `v${String(i)}\n`);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      assert.equal(badge('a.txt'), 'M');
      r.git('add', 'a.txt');
      r.git('commit', '-q', '-m', 'second');
      await until(() => badge('a.txt') === undefined && !/±/.test(metaText()), 'после коммита чисто', 10000);
      r.git('checkout', '-q', 'feature');
      await until(() => /⎇ feature/.test(metaText()), 'ветка сменилась', 10000);
      m.view.dispose();
    });
  });

  it('без плагина git дерево работает без отметок и без ветки: «не git»', async () => {
    using r = repo({ files: { 'a.txt': 'a\n' } });
    r.write('a.txt', 'changed\n');
    await using t = await rig({ noGit: true });
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const m = await show(t);
      assert.equal(m.rowByName('a.txt').children.some((c) => c.className.startsWith('badge')), false);
      assert.equal(m.rows()[0]?.children.find((c) => c.className === 'meta')?.children[0]?.textContent, 'не git');
      m.view.dispose();
    });
  });
});

describe('строка дерева - источник перетаскивания (FR-3001)', () => {
  it('корень, каталог и файл draggable; dragstart гасит собственное перетаскивание и отдаёт ядру абсолютный путь строки', async () => {
    using r = repo();
    sample(r);
    await using t = await rig();
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const m = await show(t);
      for (const row of m.rows()) assert.equal(row.draggable, true, row.title);
      const file = m.rowByName('f.txt');
      const event = file.fire('dragstart');
      assert.equal(event.prevented, true);
      m.rowByName('a').fire('dragstart');
      m.rows()[0]?.fire('dragstart');
      assert.deepEqual(m.ui.drag.started, [`${r.dir}/f.txt`, `${r.dir}/a`, r.dir]);
      m.view.dispose();
    });
  });
});

describe('гонка клика и обновления (FR-4007)', () => {
  it('ответ состояния, запрошенный до клика и вернувшийся после него, не откатывает дерево', async () => {
    using r = repo();
    sample(r);
    await using t = await rig();
    await t.setProject([r.dir]);
    await withDocument(async () => {
      let hold: (() => void) | undefined;
      let holdNext = false;
      const m = await show(t, (ctx) => ({
        ...ctx,
        commands: {
          run: async (command: string, ...args: unknown[]) => {
            const value = await ctx.commands.run(command, ...args);
            // ответ files.view готов (снимок взят до клика), но вид получит его позже клика
            if (command === 'files.view' && holdNext) {
              holdNext = false;
              await new Promise<void>((resolve) => (hold = resolve));
            }
            return value;
          },
        },
      }));
      holdNext = true;
      // сообщение главной части заставляет вид запросить состояние; ответ придержан на пути к виду
      t.emitView({ changed: 1 });
      await until(() => hold !== undefined, 'запрос состояния ушёл');
      m.rowByName('a').click();
      await until(() => m.rows().some((x) => m.name(x) === 'x.txt'), 'клик показан');
      hold?.();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(m.rows().some((x) => m.name(x) === 'x.txt'), true, 'устаревший ответ клик не отменил');
      m.view.dispose();
    });
  });
});
