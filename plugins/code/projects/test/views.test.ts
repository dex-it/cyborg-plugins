// Виды плагина: «Проекты» (список, выбор, удаление) и диалог свойств проекта (модальное окно). Логика видов идёт на настоящем ядре:
// команды вида - `kernel.runOwn`, диалоги - слой диалогов ядра (`kernel.showDialog`, ответ человека - `answerDialog`), закрытие окна - `closeModal`.
// DOM подменён минимумом (test/dom.ts); настоящий фрейм и элементы cy-* проверяет окно приложения.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Disposable, DialogSpec, UiContext } from '@cyborg-harness/contracts';
import type { TestKernel } from '@cyborg-harness/testing';
import { FakeElement, until, withDocument } from './dom.ts';
import { rig, sourcesProvider, type Rig } from './kit.ts';

const asRoot = (e: FakeElement) => e as unknown as HTMLElement;

/** `UiContext` вида плагина `projects` поверх настоящего ядра. */
function context(kernel: TestKernel, view: string, extra: Partial<UiContext> = {}): { ctx: UiContext; messages: ((m: unknown) => void)[] } {
  const messages: ((m: unknown) => void)[] = [];
  const disposable: Disposable = { dispose() {} };
  const ctx = {
    pluginId: 'projects',
    view,
    commands: { run: (command: string, ...args: unknown[]) => kernel.runOwn('projects', command, ...args) },
    dialogs: { show: (spec: DialogSpec) => kernel.showDialog('projects', view, spec) },
    channel: { post: async () => undefined, onMessage: (l: (m: unknown) => void) => (messages.push(l), disposable) },
    onVisibilityChange: () => disposable,
    modal: undefined,
    ...extra,
  } as unknown as UiContext;
  return { ctx, messages };
}

const repoProject = (id: string, name: string, repos: string[]) => ({ id, name, description: '', repos });
const loadOf = async (t: Rig) => (await t.kernel.run('projects.load')) as { projects: { id: string; name: string; repos: string[] }[]; lastProjectId: string | null; problem: { text: string } | null };

describe('вид «Проекты»', () => {
  it('пустой воркспейс: подсказка «Проектов нет», «Свойства» и «Удалить» недоступны', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    await withDocument(async () => {
      const { mount } = await import('../ui/projects.ts');
      const root = new FakeElement('div');
      const view = mount(asRoot(root), context(t.kernel, 'projects').ctx);
      const list = root.find('projects');
      await until(() => Array.isArray(list.items), 'список получен');
      assert.deepEqual(list.items, []);
      assert.equal(root.find('empty').hidden, false);
      assert.equal(root.find('edit').disabled, true);
      assert.equal(root.find('remove').disabled, true);
      view.dispose();
      assert.deepEqual(root.children, []);
    });
  });

  it('список, выбор и сообщение главной части: клик по проекту выбирает его, «Свойства» доступны, меню окна следует за выбором', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const [a, b] = [await t.dir('a'), await t.dir('b')] as [string, string];
    await t.kernel.run('projects.save', { projects: [repoProject('1', 'Первый', [a]), repoProject('2', 'Второй', [a, b])], lastProjectId: null });
    await withDocument(async () => {
      const { mount } = await import('../ui/projects.ts');
      const root = new FakeElement('div');
      const { ctx, messages } = context(t.kernel, 'projects');
      const view = mount(asRoot(root), ctx);
      const list = root.find('projects');
      await until(() => (list.items as unknown[] | undefined)?.length === 2, 'два проекта');
      assert.deepEqual((list.items as { label: string; detail: string }[]).map((i) => [i.label, i.detail]), [['Первый', a], ['Второй', `${a}, ${b}`]]);
      assert.equal(root.find('empty').hidden, true);
      assert.equal(root.find('edit').disabled, true, 'проект не выбран');
      list.fire('cy-select', { detail: { id: '2' } });
      await until(() => root.find('projects').selected === '2', 'выбран второй');
      assert.equal(root.find('edit').disabled, false);
      assert.equal((await loadOf(t)).lastProjectId, '2');
      await t.kernel.refreshMenus();
      assert.equal(t.kernel.menus.find((m) => m.id === 'properties')?.enabled, true);
      // главная часть сообщила о перемене (выбор из меню или другого плагина): вид перечитывает
      await t.kernel.run('projects.select', '1');
      for (const listener of messages) listener({ changed: true });
      await until(() => root.find('projects').selected === '1', 'вид перечитал выбор');
      view.dispose();
    });
  });

  it('«Удалить» спрашивает через слой диалогов ядра: «Отмена» оставляет проект, «Удалить» убирает', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const a = await t.dir('a');
    await t.kernel.run('projects.save', { projects: [repoProject('1', 'Первый', [a])], lastProjectId: '1' });
    await withDocument(async () => {
      const { mount } = await import('../ui/projects.ts');
      const root = new FakeElement('div');
      const view = mount(asRoot(root), context(t.kernel, 'projects').ctx);
      await until(() => (root.find('projects').items as unknown[] | undefined)?.length === 1 && root.find('projects').selected === '1', 'выбранный проект виден');
      root.find('remove').fire('click');
      const first = await until(() => t.kernel.window.dialog, 'диалог показан');
      assert.deepEqual(first.spec.kind === 'ask' ? [first.spec.title, first.spec.buttons.map((b) => b.id)] : [], ['Удалить проект «Первый»?', ['remove', 'cancel']]);
      t.kernel.answerDialog(first.id, 'cancel');
      await until(() => t.kernel.window.dialog === undefined, 'диалог закрыт');
      assert.equal((await loadOf(t)).projects.length, 1);
      root.find('remove').fire('click');
      const second = await until(() => t.kernel.window.dialog, 'диалог показан снова');
      t.kernel.answerDialog(second.id, 'remove');
      await until(() => (root.find('projects').items as unknown[]).length === 0, 'список опустел');
      assert.equal((await loadOf(t)).lastProjectId, null);
      view.dispose();
    });
  });

  it('замечание о каталогах показано в виде, ошибка команды - в строке ошибки, а не в alert', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    await t.kernel.run('projects.save', { projects: [repoProject('1', 'Первый', [t.box.path('gone')])], lastProjectId: null });
    await withDocument(async () => {
      const { mount } = await import('../ui/projects.ts');
      const root = new FakeElement('div');
      const view = mount(asRoot(root), context(t.kernel, 'projects').ctx);
      const banner = root.find('problem');
      await until(() => banner.hidden === false, 'замечание показано');
      assert.match(banner.textContent, /недоступна остальным плагинам/);
      assert.equal(banner.getAttribute('role'), 'alert');
      view.dispose();
    });
  });
});

/** Открывает форму как это делает меню: `projects.new` или `projects.edit`; окно ждёт на экране, пока вид не закроет его. */
async function openForm(t: Rig, command: 'projects.new' | 'projects.edit', ...args: unknown[]) {
  const result = t.kernel.runOwn('projects', command, ...args);
  const modal = await until(() => t.kernel.window.modal, 'модальное окно');
  const data = t.kernel.modalFor('projects', 'project-form')?.data;
  const closed: unknown[] = [];
  const { ctx } = context(t.kernel, 'project-form', {
    modal: {
      data,
      resize: async () => undefined,
      close: async (value?: unknown) => {
        closed.push(value);
        t.kernel.closeModal('projects', 'project-form', value);
      },
    },
  });
  return { result, modal, ctx, closed };
}

describe('диалог свойств проекта', () => {
  it('новый проект: окно с заголовком и Escape у вида; название, папка кнопкой «Папка…», секция другого плагина - сохраняются, проект выбирается', async () => {
    const sources = sourcesProvider();
    await using t = await rig({ extra: [sources.plugin] });
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'trackers' });
    const repo = await t.dir('repo');
    await withDocument(async () => {
      const { mount } = await import('../ui/project-form.ts');
      const { result, modal, ctx, closed } = await openForm(t, 'projects.new');
      assert.equal(modal.title, 'Новый проект');
      assert.equal(modal.escape, 'view');
      const root = new FakeElement('div');
      const view = mount(asRoot(root), ctx);
      await until(() => root.findAll((e) => e.id === 'sources-github').length > 0, 'секция показана');
      assert.equal(root.find('save').disabled, false);
      root.find('name').value = 'Новый';
      root.find('description').value = 'описание';
      t.dialog.push([repo]);
      root.find('add').fire('click');
      await until(() => (root.find('repos').items as unknown[]).length === 1, 'папка добавлена');
      root.find('sources-github').checked = true;
      root.find('save').fire('click');
      assert.deepEqual(await result, { saved: true, id: closed.length ? (closed[0] as { id: string }).id : '' });
      const saved = await loadOf(t);
      assert.deepEqual(saved.projects.map((p) => [p.name, p.repos]), [['Новый', [repo]]]);
      assert.equal(saved.lastProjectId, saved.projects[0]?.id, 'новый проект выбран');
      assert.deepEqual(sources.saved, [{ projectId: saved.projects[0]?.id, values: { github: true, gitlab: false } }]);
      view.dispose();
    });
  });

  it('пустое название: окно остаётся, причина в строке ошибки; ошибка секции поставщика называет секцию', async () => {
    const sources = sourcesProvider();
    await using t = await rig({ extra: [sources.plugin] });
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'trackers' });
    await withDocument(async () => {
      const { mount } = await import('../ui/project-form.ts');
      const { ctx, closed, result } = await openForm(t, 'projects.new');
      const root = new FakeElement('div');
      const view = mount(asRoot(root), ctx);
      await until(() => root.findAll((e) => e.id === 'sources-github').length > 0, 'форма готова');
      root.find('save').fire('click');
      await until(() => root.find('error').hidden === false, 'ошибка показана');
      assert.equal(root.find('error').textContent, 'Нужно название проекта');
      assert.deepEqual(closed, [], 'окно не закрыто');
      view.dispose();
      t.kernel.closeModal('projects', 'project-form', undefined);
      assert.equal(await result, undefined);
    });
  });

  it('свойства существующего проекта: поля заполнены, порядок репозиториев меняется кнопками, «Убрать» убирает', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const [a, b, c] = [await t.dir('a'), await t.dir('b'), await t.dir('c')] as [string, string, string];
    await t.kernel.run('projects.save', { projects: [{ id: '1', name: 'Первый', description: 'о', repos: [a, b, c] }], lastProjectId: '1' });
    await withDocument(async () => {
      const { mount } = await import('../ui/project-form.ts');
      const { ctx, result, modal } = await openForm(t, 'projects.edit');
      assert.equal(modal.title, 'Свойства проекта');
      const root = new FakeElement('div');
      const view = mount(asRoot(root), ctx);
      await until(() => root.find('name').value === 'Первый', 'форма заполнена');
      assert.equal(root.find('description').value, 'о');
      const repos = () => (root.find('repos').items as { id: string }[]).map((i) => i.id);
      assert.deepEqual(repos(), [a, b, c]);
      root.find('repos').fire('cy-select', { detail: { id: c } });
      root.find('up').fire('click');
      root.find('up').fire('click');
      assert.deepEqual(repos(), [c, a, b], 'FR-10004: порядок меняется');
      assert.equal(root.find('up').disabled, true);
      root.find('repos').fire('cy-select', { detail: { id: b } });
      root.find('drop').fire('click');
      assert.deepEqual(repos(), [c, a]);
      root.find('save').fire('click');
      assert.deepEqual(await result, { saved: true, id: '1' });
      assert.deepEqual((await loadOf(t)).projects[0]?.repos, [c, a]);
      view.dispose();
    });
  });

  it('отмена: без правок закрывает сразу; с правкой спрашивает через слой диалогов, «Остаться» оставляет окно, Escape - та же отмена', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    await withDocument(async (doc) => {
      const { mount } = await import('../ui/project-form.ts');
      const clean = await openForm(t, 'projects.new');
      const root = new FakeElement('div');
      const view = mount(asRoot(root), clean.ctx);
      await until(() => root.find('save'), 'форма готова');
      await new Promise((resolve) => setTimeout(resolve, 20));
      root.find('cancel').fire('click');
      assert.deepEqual(await clean.result, { saved: false });
      assert.equal(t.kernel.window.dialog, undefined, 'вопроса без правок нет');
      view.dispose();

      const dirty = await openForm(t, 'projects.new');
      const root2 = new FakeElement('div');
      const view2 = mount(asRoot(root2), dirty.ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      root2.find('name').value = 'правка';
      doc.press('Escape');
      const ask = await until(() => t.kernel.window.dialog, 'вопрос о несохранённой правке');
      assert.equal(ask.spec.kind === 'ask' ? ask.spec.title : '', 'Закрыть без сохранения?');
      t.kernel.answerDialog(ask.id, 'stay');
      await until(() => t.kernel.window.dialog === undefined, 'вопрос закрыт');
      assert.deepEqual(dirty.closed, [], 'окно осталось');
      root2.find('cancel').fire('click');
      const again = await until(() => t.kernel.window.dialog, 'вопрос снова');
      t.kernel.answerDialog(again.id, 'discard');
      assert.deepEqual(await dirty.result, { saved: false });
      assert.deepEqual((await loadOf(t)).projects, []);
      view2.dispose();
    });
  });
});
