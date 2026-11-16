// Плагин на настоящем ядре: состав, права, каналы владельца, сохранение и проверка проекта, события, секции других плагинов.
// Перенос stores.test.ts (ProjectStore, validateProjectsState, saveProjectsState) и части menu.test.ts ai-cyborg: что осталось у плагина, что ушло в ядро и trackers - в README и PR.

import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { checkPlugin } from '@cyborg-harness/core/plugin-check';
import { CHANNELS, type FormReply, type LoadReply } from '../index.ts';
import { sandbox } from '@cyborg-harness/testing';
import { home, makeDir, rig, sourcesProvider } from './kit.ts';

const project = (id: string, repos: string[], extra: Record<string, unknown> = {}) => ({ id, name: `проект ${id}`, description: 'd', repos, ...extra });

describe('плагин projects', () => {
  it('проверка состава: манифест, файлы, правило импортов - без замечаний; права названы', async () => {
    const report = await checkPlugin(home, { ignore: ['dist'], declarationPackages: ['@cyborg-plugins/contracts'] });
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.permissions.map((p) => p.trim()).sort(), ['читает файлы: выбранное человеком в диалоге', 'задаёт корни проектов, доступные другим плагинам'].sort());
  });

  it('активен без отказов; пустой воркспейс - ни проектов, ни выбранного, ни замечаний', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    assert.deepEqual(t.kernel.journal.filter((e) => e.kind === 'denied' || e.kind === 'failed' || e.kind === 'invalid'), []);
    assert.deepEqual(await t.kernel.run('projects.load'), { projects: [], lastProjectId: null, problem: null });
    assert.equal(await t.kernel.run('projects.problem'), null);
  });

  it('каналы владельца отвечают командами: соответствие манифесту и ответы', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const commands = t.kernel.manifests.find((m) => m.id === 'projects')?.commands ?? {};
    for (const [channel, command] of Object.entries(CHANNELS)) assert.ok(command in commands, `${channel} -> ${command}: команды нет в манифесте`);
    assert.deepEqual(Object.keys(CHANNELS), ['dialog:pickDir', 'projects:load', 'projects:problem', 'projects:save', 'project:selected']);
    // projects:save и projects:load: сохранённое читается тем же ответом
    const a = await t.dir('a');
    const saved = (await t.kernel.run('projects.save', { projects: [project('p1', [a])], lastProjectId: 'p1' })) as LoadReply;
    assert.deepEqual(saved.projects.map((p) => p.id), ['p1']);
    assert.deepEqual(await t.kernel.run('projects.load'), saved);
    // project:selected
    assert.equal(await t.kernel.run('projects.select', ''), null);
    assert.equal(await t.kernel.run('projects.select', 'p1'), 'p1');
    await assert.rejects(t.kernel.run('projects.select', 'нет'), /Проекта нет/);
    // dialog:pickDir: отмена - null
    assert.equal(await t.kernel.run('projects.pick-dir'), null);
  });

  it('состояние переживает «перезапуск»: проекты в слое воркспейса, выбранный - в state', async () => {
    await using box = await sandbox('projects-');
    const a = await makeDir(box, 'a');
    await using first = await rig({ box });
    await first.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    await first.kernel.run('projects.save', { projects: [project('1', [a]), project('2', [a])], lastProjectId: '1' });
    const config = first.store.docs.get('workspace');
    const state = first.state.docs.get('workspace');
    assert.deepEqual(config?.projects, { $version: 1, items: [project('1', [a]), project('2', [a])] });
    assert.deepEqual(state?.projects, { $version: 1, lastProjectId: '1' });
    await using second = await rig({ box, config: { projects: config?.projects as Record<string, unknown> }, state: { projects: state?.projects as Record<string, unknown> } });
    await second.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const loaded = (await second.kernel.run('projects.load')) as LoadReply;
    assert.deepEqual(loaded.projects, [project('1', [a]), project('2', [a])]);
    assert.equal(loaded.lastProjectId, '1');
  });

  it('проверка при сохранении: негодное состояние отклоняется с причиной, файл не меняется', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const a = await t.dir('a');
    const bad: [unknown, RegExp][] = [
      [{ projects: {} }, /не массив/],
      [{ projects: [1] }, /не объект/],
      [{ projects: [project('1', [a], { name: ' ' })] }, /название/],
      [{ projects: [project('', [a])] }, /идентификатор/],
      [{ projects: [project('1', ['относительный/путь'])] }, /полный путь/],
      [{ projects: [project('1', [`${a}/../x`])] }, /без «\.\.»/],
      [{ projects: [project('1', [a]), project('1', [a])] }, /повторяется/],
      [{ projects: [project('1', [a])], lastProjectId: 'нет' }, /Выбранного проекта нет/],
    ];
    for (const [state, reason] of bad) await assert.rejects(t.kernel.run('projects.save', state as Record<string, unknown>), reason);
    assert.equal(t.store.docs.get('workspace')?.projects, undefined);
    assert.equal(t.store.saves.length, 0);
  });

  it('пути репозиториев при сохранении физические (FR-5007): ссылка и её цель сливаются в один репозиторий', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const real = await t.dir('real');
    const link = t.box.path('link');
    await symlink(real, link);
    t.dialog.push([link]);
    assert.equal(await t.kernel.run('projects.pick-dir'), real, 'диалог отдаёт физический путь');
    const saved = (await t.kernel.run('projects.save', { projects: [project('1', [link, real])], lastProjectId: null })) as LoadReply;
    assert.deepEqual(saved.projects[0]?.repos, [real]);
  });

  it('нет каталога: путь остаётся как задан, проект сохраняется (дерево покажет ошибку)', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const missing = t.box.path('gone');
    const saved = (await t.kernel.run('projects.save', { projects: [project('1', [missing])], lastProjectId: null })) as LoadReply;
    assert.deepEqual(saved.projects[0]?.repos, [missing]);
    // каталога нет: ядро корень не принимает, причина - в замечании, окно и сохранение целы
    const problem = (await t.kernel.run('projects.problem')) as { kind: string; detail: string } | null;
    assert.equal(problem?.kind, 'roots');
    assert.ok(problem?.detail.includes(missing));
  });

  it('порядок репозиториев проекта сохраняется (FR-10004)', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const [a, b, c] = [await t.dir('a'), await t.dir('b'), await t.dir('c')] as [string, string, string];
    await t.kernel.run('projects.save', { projects: [project('1', [c, a, b])], lastProjectId: null });
    const list = (await t.kernel.run('projects.load')) as LoadReply;
    assert.deepEqual(list.projects[0]?.repos, [c, a, b]);
  });

  it('удаление проекта: проект уходит из списка и выбор снимается', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const a = await t.dir('a');
    await t.kernel.run('projects.save', { projects: [project('1', [a]), project('2', [a])], lastProjectId: '2' });
    const after = (await t.kernel.run('projects.remove', '2')) as LoadReply;
    assert.deepEqual(after.projects.map((p) => p.id), ['1']);
    assert.equal(after.lastProjectId, null);
    await assert.rejects(t.kernel.run('projects.remove', '2'), /Проекта нет/);
  });
});

describe('cyborg.projects и cyborg.project-settings', () => {
  it('контракт: список, выбранный, hasSelected и события changed', async () => {
    const consumer = {
      manifest: { id: 'watcher', version: '1.0.0', engines: { cyborg: '^1' }, requires: { 'cyborg.projects': '^1' }, commands: { 'watcher.events': {}, 'watcher.snapshot': {} } },
      module: {
        activate(ctx: import('@cyborg-harness/contracts').PluginContext) {
          const events: unknown[] = [];
          const projects = ctx.contracts.get('cyborg.projects', 1);
          if (!projects) throw new Error('нет поставщика');
          void projects.onChange((change) => void events.push(change));
          ctx.commands.register('watcher.events', () => events);
          ctx.commands.register('watcher.snapshot', async () => ({ list: await projects.list(), selected: await projects.selected(), has: await projects.hasSelected() }));
          return undefined;
        },
      },
    };
    await using t = await rig({ extra: [consumer] });
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'watcher' });
    const a = await t.dir('a');
    assert.deepEqual(await t.kernel.run('watcher.snapshot'), { list: [], selected: null, has: false });
    await t.kernel.run('projects.save', { projects: [project('1', [a])], lastProjectId: '1' });
    await t.kernel.run('projects.save', { projects: [{ ...project('1', [a]), name: 'новое имя' }], lastProjectId: '1' });
    await t.kernel.run('projects.remove', '1');
    assert.deepEqual(await t.kernel.run('watcher.events'), [
      { type: 'added', projectId: '1' },
      { type: 'selected', projectId: '1' },
      { type: 'updated', projectId: '1' },
      { type: 'removed', projectId: '1' },
      { type: 'selected', projectId: null },
    ]);
    assert.deepEqual(await t.kernel.run('watcher.snapshot'), { list: [], selected: null, has: false });
  });

  it('секции других плагинов: форма получает описание и значения, проверка и запись идут через поставщика', async () => {
    const sources = sourcesProvider();
    await using t = await rig({ extra: [sources.plugin] });
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'trackers' });
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const a = await t.dir('a');
    const form = (await t.kernel.run('projects.form')) as FormReply;
    assert.equal(form.project, null);
    assert.deepEqual(form.sections.map((s) => [s.provider, s.section.id, s.values]), [['trackers', 'sources', { github: false, gitlab: false }]]);
    // негодные значения секции: проект не сохраняется, причина называет секцию
    await assert.rejects(
      t.kernel.run('projects.save', { projects: [project('1', [a])], lastProjectId: null, settings: { '1': { sources: { github: 'да', gitlab: false } } } }),
      /Источники задач: оба флага должны быть булевыми/,
    );
    assert.equal(t.store.docs.get('workspace')?.projects, undefined);
    assert.deepEqual(sources.saved, []);
    // годные - проект и секция записаны
    await t.kernel.run('projects.save', { projects: [project('1', [a])], lastProjectId: '1', settings: { '1': { sources: { github: true, gitlab: false } } } });
    assert.deepEqual(sources.saved, [{ projectId: '1', values: { github: true, gitlab: false } }]);
    const edit = (await t.kernel.run('projects.form', '1')) as FormReply;
    assert.equal(edit.project?.name, 'проект 1');
  });

  it('секция не записалась: проект уже сохранён, отказ называет секцию', async () => {
    const sources = sourcesProvider({ fail: 'нет доступа к трекеру' });
    await using t = await rig({ extra: [sources.plugin] });
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const a = await t.dir('a');
    await assert.rejects(
      t.kernel.run('projects.save', { projects: [project('1', [a])], lastProjectId: null, settings: { '1': { sources: { github: true, gitlab: true } } } }),
      /Проект сохранён, но секции не записаны: Источники задач: нет доступа к трекеру/,
    );
    assert.equal(((await t.kernel.run('projects.load')) as LoadReply).projects.length, 1);
  });
});
