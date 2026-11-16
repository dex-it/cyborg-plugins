// Перенос части menu.test.ts ai-cyborg (меню проекта): пункты «Новый проект…» и «Свойства проекта…», доступность по выбранному проекту, вызов правки.
// Раньше меню собирало приложение (`WorkspaceMenu.hasProject`, `newProject`, `editProject`); теперь это вклад плагина `contributes.menus`, а доступность - булев член контракта `hasSelected`.
// Остальное menu.test.ts (роли, «Недавние», «Справка», поиск, расширения, уведомления) - меню приложения, ядра и других плагинов.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { until } from './dom.ts';
import { rig } from './kit.ts';

const mine = (t: Awaited<ReturnType<typeof rig>>) => t.kernel.menus.filter((m) => m.pluginId === 'projects');
const byId = (t: Awaited<ReturnType<typeof rig>>, id: string) => mine(t).find((m) => m.id === id);

describe('меню проекта', () => {
  it('пункты в меню «Воркспейс» по порядку: «Новый проект…», «Свойства проекта…»; у «Нового» доступность не зависит от проекта', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    await t.kernel.refreshMenus();
    assert.deepEqual(mine(t).map((m) => [m.menu, m.title, m.command]), [
      ['workspace', 'Новый проект…', 'projects.new'],
      ['workspace', 'Свойства проекта…', 'projects.edit'],
    ]);
    assert.equal(byId(t, 'new')?.enabled, true);
  });

  it('без выбранного проекта «Свойства проекта» недоступны, с выбранным доступны, при снятии выбора снова недоступны', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const a = await t.dir('a');
    await t.kernel.refreshMenus();
    assert.equal(byId(t, 'properties')?.enabled, false);
    await t.kernel.run('projects.save', { projects: [{ id: '1', name: 'п', description: '', repos: [a] }], lastProjectId: '1' });
    await t.kernel.refreshMenus();
    assert.equal(byId(t, 'properties')?.enabled, true);
    await t.kernel.run('projects.select', '');
    await t.kernel.refreshMenus();
    assert.equal(byId(t, 'properties')?.enabled, false);
    await assert.rejects(t.kernel.runMenuItem('projects', 'properties'), { code: 'Unavailable' });
  });

  it('клики вызывают команды: «Новый проект…» открывает форму нового проекта, «Свойства проекта…» - форму выбранного', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const a = await t.dir('a');
    await t.kernel.run('projects.save', { projects: [{ id: '1', name: 'п', description: '', repos: [a] }], lastProjectId: '1' });
    await t.kernel.refreshMenus();

    const created = t.kernel.runMenuItem('projects', 'new');
    const fresh = await until(() => t.kernel.window.modal, 'форма нового проекта');
    assert.deepEqual([fresh.view, fresh.title], ['project-form', 'Новый проект']);
    assert.deepEqual(t.kernel.modalFor('projects', 'project-form')?.data, {});
    t.kernel.closeModal('projects', 'project-form', { saved: false });
    assert.deepEqual(await created, { saved: false });

    const edited = t.kernel.runMenuItem('projects', 'properties');
    const props = await until(() => t.kernel.window.modal, 'форма свойств');
    assert.equal(props.title, 'Свойства проекта');
    assert.deepEqual(t.kernel.modalFor('projects', 'project-form')?.data, { projectId: '1' });
    t.kernel.closeModal('projects', 'project-form', { saved: true, id: '1' });
    assert.deepEqual(await edited, { saved: true, id: '1' });
  });

  it('команды projects.new и projects.edit открыты другим плагинам (callers: plugins), остальное - только виду', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const commands = t.kernel.manifests.find((m) => m.id === 'projects')?.commands ?? {};
    const open = Object.entries(commands).filter(([, spec]) => (spec as { callers?: string }).callers === 'plugins').map(([name]) => name);
    assert.deepEqual(open.sort(), ['projects.edit', 'projects.new', 'projects.select']);
  });

  it('плагин выключен: пункты остаются в меню, но недоступны', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    await t.kernel.disable('projects');
    await t.kernel.refreshMenus();
    assert.deepEqual(mine(t).map((m) => [m.id, m.enabled]), [['new', false], ['properties', false]]);
  });
});
