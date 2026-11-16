// Смена ветки кликом по строке с веткой (FR-7005, 07-branch-switch): меню с поиском, управление с клавиатуры (list-keys), отказ при работающей сессии приходит от `cyborg.git.switch`
// и показан в меню. Ядро, `git` и `projects` настоящие, сессии - подставной поставщик с `uses`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeElement, until, withDocument } from './dom.ts';
import { asRoot, fakeSessions, repo, rig, uiRig, type Rig } from './kit.ts';

async function show(t: Rig) {
  const { mount } = await import('../ui/tree.ts');
  const root = new FakeElement('div');
  root.mounted = true;
  const ui = uiRig(t);
  const view = mount(asRoot(root), ui.ctx);
  const tree = root.find('tree');
  const rows = (): FakeElement[] => tree.querySelectorAll('[role="treeitem"]');
  await until(() => rows().length > 0, 'дерево показано');
  const meta = (): FakeElement | undefined => rows()[0]?.children.find((c) => c.className === 'meta');
  return {
    root,
    view,
    ui,
    rows,
    meta,
    branchButton: (): FakeElement | undefined => meta()?.children.find((c) => c.classList.contains('branch')),
    menu: root.find('branch-menu'),
    items: (): FakeElement[] => root.find('branch-menu').querySelectorAll('.menu-item'),
    problem: (): FakeElement => root.find('branch-menu').querySelectorAll('.menu-error')[0] as FakeElement,
    metaText: (): string => meta()?.children.map((c) => c.textContent).join('') ?? '',
  };
}

describe('меню ветки (FR-7005)', () => {
  it('клик по ветке в строке корня открывает меню: текущая отмечена, остальные - пункты menuitemradio; клик по текущей ничего не меняет', async () => {
    using r = repo({ branches: ['feature', 'fix/x'] });
    await using t = await rig();
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const v = await show(t);
      const button = v.branchButton();
      assert.ok(button, 'у репозитория проекта ветка - кнопка');
      assert.equal(button.textContent, '⎇ main');
      assert.equal(v.menu.hidden, true);
      const click = button.fire('click');
      assert.equal(click.stopped, true, 'клик по кнопке строку корня не сворачивает');
      await until(() => v.items().length === 3, 'ветки показаны');
      assert.equal(v.menu.hidden, false);
      assert.equal(v.menu.getAttribute('role'), 'menu');
      const labels = v.items().map((i) => [i.children[0]?.textContent, i.getAttribute('role'), i.getAttribute('aria-checked')]);
      assert.deepEqual(labels.find((l) => l[0] === '✓ main'), ['✓ main', 'menuitemradio', 'true']);
      assert.deepEqual(labels.filter((l) => l[2] === 'false').map((l) => l[0]).sort(), ['feature', 'fix/x']);
      v.items().find((i) => i.classList.contains('current'))?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(v.ui.commands.some((c) => c.name === 'files.switch'), false, 'текущая ветка - без вызова');
      v.view.dispose();
    });
  });

  it('поиск сужает список; Enter в поле выбирает первую найденную ветку: ветка сменилась, меню закрыто, строка корня показывает новую', async () => {
    using r = repo({ branches: ['feature', 'fix/x'] });
    await using t = await rig();
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const v = await show(t);
      v.branchButton()?.fire('click');
      await until(() => v.items().length === 3, 'ветки показаны');
      const filter = v.menu.querySelectorAll('.menu-filter')[0];
      assert.ok(filter);
      filter.value = 'fix';
      filter.fire('input');
      assert.deepEqual(v.items().map((i) => i.children[0]?.textContent), ['fix/x']);
      filter.value = 'нет такой';
      filter.fire('input');
      assert.deepEqual(v.menu.querySelectorAll('.branch-list')[0]?.children.map((c) => c.textContent), ['Нет веток']);
      filter.value = 'fix';
      filter.fire('input');
      filter.fire('keydown', { key: 'Enter' });
      await until(() => v.menu.hidden, 'меню закрыто после смены');
      assert.equal(r.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'fix/x');
      await until(() => v.branchButton()?.textContent === '⎇ fix/x', 'строка корня показывает новую ветку', 10000);
      v.view.dispose();
    });
  });

  it('с клавиатуры: из поля ArrowDown уходит на первый пункт, стрелки перебирают, Enter выбирает, Escape закрывает меню и возвращает фокус на кнопку', async () => {
    using r = repo({ branches: ['feature'] });
    await using t = await rig();
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const v = await show(t);
      const button = v.branchButton();
      assert.ok(button);
      button.fire('click');
      await until(() => v.items().length === 2, 'ветки показаны');
      const filter = v.menu.querySelectorAll('.menu-filter')[0];
      assert.ok(filter);
      assert.ok(filter.focused > 0, 'фокус в поле поиска');
      const down = filter.fire('keydown', { key: 'ArrowDown' });
      assert.equal(down.prevented, true);
      const [first, second] = v.items();
      assert.ok(first && second);
      assert.equal(first.focused, 1);
      assert.deepEqual(v.items().map((i) => i.tabIndex), [0, -1], 'в порядке табуляции один пункт');
      first.fire('keydown', { key: 'ArrowDown' });
      assert.equal(second.focused, 1);
      first.fire('keydown', { key: 'ArrowUp' });
      assert.equal(v.items()[1]?.focused, 2, 'вверх с первого - на последний, по кругу');
      v.items()[0]?.fire('keydown', { key: 'Escape' });
      assert.equal(v.menu.hidden, true);
      assert.ok(button.focused > 0, 'фокус вернулся на кнопку ветки');
      button.fire('click');
      await until(() => v.items().length === 2, 'меню открыто снова');
      const target = v.items().find((i) => i.children[0]?.textContent === 'feature');
      assert.ok(target);
      target.fire('keydown', { key: 'Enter' });
      await until(() => v.menu.hidden, 'смена по Enter на пункте');
      assert.equal(r.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature');
      v.view.dispose();
    });
  });

  it('отказ при работающей сессии приходит от cyborg.git.switch и показан в меню: ветка не сменилась, меню остаётся; сессия вышла - смена проходит', async () => {
    using r = repo({ branches: ['feature'] });
    const sessions = fakeSessions();
    await using t = await rig({ sessions });
    await t.setProject([r.dir]);
    sessions.live.add(r.dir);
    await withDocument(async () => {
      const v = await show(t);
      v.branchButton()?.fire('click');
      await until(() => v.items().length === 2, 'ветки показаны');
      v.items().find((i) => i.children[0]?.textContent === 'feature')?.click();
      await until(() => !v.problem().hidden, 'отказ показан');
      assert.match(v.problem().textContent, /Ветка не сменилась: в репозитории работает сессия Claude: веткой управляет она/);
      assert.equal(v.problem().getAttribute('role'), 'alert');
      assert.equal(v.menu.hidden, false);
      assert.equal(r.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
      sessions.live.delete(r.dir);
      v.items().find((i) => i.children[0]?.textContent === 'feature')?.click();
      await until(() => v.menu.hidden, 'меню закрыто после смены');
      assert.equal(r.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature');
      v.view.dispose();
    });
  });

  it('отказ git (конфликт с незакоммиченной правкой) и фильтр репозитория тоже показаны причиной, а не молчанием', async () => {
    using r = repo({ files: { 'a.txt': 'main\n' }, branches: [] });
    r.git('checkout', '-q', '-b', 'other');
    r.write('a.txt', 'other\n');
    r.git('commit', '-q', '-am', 'other');
    r.git('checkout', '-q', 'main');
    r.write('a.txt', 'dirty\n');
    await using t = await rig();
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const v = await show(t);
      v.branchButton()?.fire('click');
      await until(() => v.items().length === 2, 'ветки показаны');
      v.items().find((i) => i.children[0]?.textContent === 'other')?.click();
      await until(() => !v.problem().hidden, 'отказ показан');
      assert.match(v.problem().textContent, /^Ветка не сменилась: .+/);
      assert.equal(r.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
      v.view.dispose();
    });
  });

  it('корень не репозиторий проекта (worktree сессии): ветка показана, но не кнопка - «Веткой управляет сессия Claude»', async () => {
    using r = repo({ files: { 'a.txt': 'a\n' } });
    const worktree = `${r.dir}/.claude/worktrees/wt`;
    r.git('worktree', 'add', '-q', '-b', 'wt', worktree);
    const sessions = fakeSessions();
    await using t = await rig({ sessions });
    await t.setProject([r.dir]);
    sessions.live.add(r.dir);
    sessions.emit('s1', { type: 'cwd', cwd: worktree });
    await withDocument(async () => {
      const v = await show(t);
      await until(() => v.rows()[0]?.title.startsWith(worktree), 'корень сессии - worktree', 10000);
      assert.equal(v.branchButton(), undefined);
      const span = v.meta()?.children.find((c) => c.textContent === '⎇ wt');
      assert.equal(span?.title, 'Веткой управляет сессия Claude');
      v.view.dispose();
    });
  });

  it('без cyborg.git меню недоступно: «не git», команды files.branches и files.switch отказывают понятной причиной', async () => {
    using r = repo();
    await using t = await rig({ noGit: true });
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const v = await show(t);
      assert.equal(v.metaText(), 'не git');
      await assert.rejects(t.run('files.branches', r.dir), /смена ветки недоступна/);
      await assert.rejects(t.run('files.switch', r.dir, 'main'), /смена ветки недоступна/);
      v.view.dispose();
    });
  });

  it('files.switch: негодное имя ветки - исключение, годное - смена и пустой ответ', async () => {
    using r = repo({ branches: ['feature'] });
    await using t = await rig();
    await t.setProject([r.dir]);
    await t.view();
    await assert.rejects(t.run('files.switch', r.dir, 5 as unknown as string));
    assert.deepEqual(await t.run('files.switch', r.dir, 'feature'), {});
    assert.equal(r.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature');
  });
});
