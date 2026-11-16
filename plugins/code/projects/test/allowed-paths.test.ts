// Перенос allowed-paths.test.ts ai-cyborg. В ai-cyborg `AllowedPaths` отвечал на `fs:*` и `git:*` по корням проектов, cwd сессий и выданным каталогам.
// В переносе это шлюз ядра: корни проектов плагин `projects` отдаёт `ctx.os.security.setRoots` (область `workspace`), выбор человека - `ctx.os.dialog` (область `granted`).
// Поэтому утверждения про «путь внутри корней разрешён, вне - отказ» проверяются на настоящем шлюзе через плагин `reader` с правом читать `workspace`,
// а чистая функция `isInside` - как была. Обработчики `createPathHandlers` (list, files, read, root, branch, status, headContent, search, write) уходят в `files`, `git` и `search`.

import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { isInside, isPlainPath } from '../model.ts';
import { rig, type Rig } from './kit.ts';

const code = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? 'без кода';
  }
};
const read = (t: Rig, file: string) => t.kernel.run('reader.read', file);
const save = (t: Rig, ...repos: string[]) => t.kernel.run('projects.save', { projects: [{ id: 'p', name: 'p', description: '', repos }], lastProjectId: null });

describe('isInside', () => {
  it('сам каталог, вложенный путь - внутри', () => {
    assert.equal(isInside('/repo', '/repo'), true);
    assert.equal(isInside('/repo/src/a.ts', '/repo'), true);
    assert.equal(isInside('/repo/', '/repo'), true);
  });
  it('сосед с общим префиксом имени, родитель и чужой каталог - снаружи', () => {
    assert.equal(isInside('/repo-evil', '/repo'), false);
    assert.equal(isInside('/repo-evil/a', '/repo'), false);
    assert.equal(isInside('/', '/repo'), false);
    assert.equal(isInside('/etc/hosts', '/repo'), false);
  });
  it('имя, начинающееся с двух точек, - не выход из каталога', () => {
    assert.equal(isInside('/repo/..hidden/a', '/repo'), true);
  });
});

describe('isPlainPath (не строка, пустая, относительная, с NUL и с сегментом ..)', () => {
  it('такие пути не принимаются', () => {
    for (const bad of [undefined, null, 7, {}, ['/x'], '', 'repo', './repo', '/repo\0/x', '/repo/../repo-evil', '/repo/a/../../x']) assert.equal(isPlainPath(bad), false, String(bad));
    assert.equal(isPlainPath('/repo/..hidden/a'), true);
  });
});

describe('корни проектов на шлюзе ядра', () => {
  it('репозиторий, его содержимое доступны остальным плагинам; сосед с общим префиксом, родитель и корень файловой системы - отказ', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const [repo, evil] = [await t.dir('repo'), await t.dir('repo-evil')] as [string, string];
    assert.equal(await code(read(t, `${repo}/key.txt`)), 'PermissionDenied', 'до сохранения проекта путь закрыт');
    await save(t, repo);
    assert.equal(await read(t, `${repo}/key.txt`), 'ключ repo');
    assert.equal(await code(read(t, `${evil}/key.txt`)), 'PermissionDenied');
    assert.equal(await code(read(t, `${t.box.root}/key.txt`)), 'PermissionDenied');
    assert.equal(await code(read(t, '/etc/hosts')), 'PermissionDenied');
    assert.equal(await code(read(t, '/')), 'PermissionDenied');
  });

  it('относительный путь и путь с .. наружу не проходят: /repo/../repo-evil закрыт', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const [repo] = [await t.dir('repo'), await t.dir('repo-evil')] as [string, string];
    await save(t, repo);
    for (const bad of ['', 'repo/key.txt', './repo/key.txt', `${repo}/../repo-evil/key.txt`, `${repo}/a/../../repo-evil/key.txt`]) {
      assert.ok(await code(read(t, bad)), `путь ${JSON.stringify(bad)} прошёл`);
    }
  });

  it('корни считаются при каждой проверке: проект добавлен - путь разрешён, репозиторий убран - отказ', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const repo = await t.dir('repo');
    assert.equal(await code(read(t, `${repo}/key.txt`)), 'PermissionDenied');
    await save(t, repo);
    assert.equal(await read(t, `${repo}/key.txt`), 'ключ repo');
    await save(t);
    assert.equal(await code(read(t, `${repo}/key.txt`)), 'PermissionDenied');
  });

  it('корень назван через символьную ссылку, путь - физическим именем: проект хранит физический путь, и он разрешён', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const real = await t.dir('real');
    const link = t.box.path('link');
    await symlink(real, link);
    t.dialog.push([link]);
    assert.equal(await t.kernel.run('projects.pick-dir'), real);
    await save(t, link);
    assert.equal(await read(t, `${real}/key.txt`), 'ключ real');
  });

  it('расхождение с ai-cyborg: ссылка внутри репозитория на каталог вне него шлюз закрывает (ai-cyborg читал её, как и в самом репозитории)', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const [repo, outside] = [await t.dir('repo'), await t.dir('outside')] as [string, string];
    await symlink(outside, `${repo}/link`);
    await save(t, repo);
    assert.equal(await read(t, `${repo}/key.txt`), 'ключ repo');
    assert.equal(await code(read(t, `${repo}/link/key.txt`)), 'PermissionDenied');
  });
});

describe('выбор каталога в диалоге (grant)', () => {
  it('каталог, выбранный в диалоге, доступен до сохранения проекта; отмена диалога ничего не выдаёт', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const picked = await t.dir('picked');
    assert.equal(await code(read(t, `${picked}/key.txt`)), 'PermissionDenied');
    assert.equal(await t.kernel.run('projects.pick-dir'), null, 'отмена диалога');
    assert.equal(await code(read(t, `${picked}/key.txt`)), 'PermissionDenied');
    t.dialog.push([picked]);
    assert.equal(await t.kernel.run('projects.pick-dir'), picked);
    assert.equal(await read(t, `${picked}/key.txt`), 'ключ picked', 'доступен без сохранения проекта');
    assert.deepEqual(((await t.kernel.run('projects.load')) as { projects: unknown[] }).projects, []);
  });

  it('родитель выбранного каталога остаётся закрытым; относительный путь из диалога не выдаётся', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const picked = await t.dir('home/proj');
    t.dialog.push([picked]);
    await t.kernel.run('projects.pick-dir');
    assert.equal(await code(read(t, `${t.box.path('home')}/key.txt`)), 'PermissionDenied');
    t.dialog.push(['picked']);
    assert.equal(await t.kernel.run('projects.pick-dir'), null);
  });

  it('выбранный каталог не пропадает после сохранения других проектов в этом запуске', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const [picked, repo] = [await t.dir('picked'), await t.dir('repo')] as [string, string];
    t.dialog.push([picked]);
    await t.kernel.run('projects.pick-dir');
    await save(t, repo);
    assert.equal(await read(t, `${picked}/key.txt`), 'ключ picked');
    assert.equal(await read(t, `${repo}/key.txt`), 'ключ repo');
  });

  it('один негодный корень не лишает остальные: удалённый каталог назван в замечании, прочие доступны', async () => {
    await using t = await rig();
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    const repo = await t.dir('repo');
    await save(t, t.box.path('gone'), repo);
    assert.equal(await read(t, `${repo}/key.txt`), 'ключ repo');
    const problem = (await t.kernel.run('projects.problem')) as { kind: string; detail: string };
    assert.equal(problem.kind, 'roots');
    assert.ok(problem.detail.includes(t.box.path('gone')));
  });
});
