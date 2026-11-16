// Повреждённый файл воркспейса не роняет окно (ADR-0004, п.4; решение D-00, строка 15 плана ядра). Перенос блока «ProjectStore: повреждённый файл» из stores.test.ts ai-cyborg.
// Что делает кто: копию `<файл>.corrupt-<время>` и отказ записи - ядро (`openWorkspace`), причину человеку и отказ только за себя - плагин `projects`.
// Тесты идут на настоящих файлах воркспейса: `openWorkspace` ядра и `load()` с плагином на хосте внутри процесса.

import assert from 'node:assert/strict';
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { PluginContext, PluginModule } from '@cyborg-harness/contracts';
import { inlineHosts, load, openWorkspace, PLUGIN_API_VERSION, type Kernel, type Workspace } from '@cyborg-harness/core';
import { sandbox, type Sandbox } from '@cyborg-harness/testing';
import projects, { type LoadReply } from '../index.ts';
import { home, makeDir } from './kit.ts';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(path.join(home, 'manifest.json'), 'utf8')) as Record<string, unknown>;
const reader: Record<string, unknown> = { id: 'reader', version: '1.0.0', engines: { cyborg: '^1' }, commands: { 'reader.ping': {} } };

interface Open {
  readonly ws: Workspace;
  readonly kernel: Kernel;
  readonly file: string;
}

async function open(box: Sandbox): Promise<Open> {
  const file = path.join(box.root, 'team.cyborg.json');
  const opened = await openWorkspace({ file, userFile: path.join(box.root, 'user.json'), stateDir: path.join(box.root, 'state') });
  assert.ok(opened.ok, 'воркспейс не открылся');
  const modules: Record<string, PluginModule> = {
    projects,
    reader: { activate: (ctx: PluginContext) => void ctx.commands.register('reader.ping', () => 'pong') },
  };
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async (entry) => modules[entry] ?? projects),
    enabled: ['projects', 'reader'],
    manifests: [manifest, reader],
    entry: (m) => m.id,
    os: { dataDir: box.path('data'), tempDir: box.path('temp') },
    schema: (_m, schemaFile) => JSON.parse(readFileSync(path.join(home, schemaFile), 'utf8')) as unknown,
    config: opened.workspace.config,
    state: opened.workspace.state,
    reservedPrefixes: ['cyborg.'],
    bundled: ['projects', 'reader'],
  });
  return { ws: opened.workspace, kernel, file };
}

const close = async (o: Open) => {
  await o.kernel.unload();
  o.ws.close();
};
const copies = async (box: Sandbox) => (await readdir(box.root)).filter((n) => n.startsWith('team.cyborg.json.corrupt-')).sort();

// Невалидный UTF-8 в середине: копия должна совпасть с файлом по байтам, а не по тексту.
const garbage = Buffer.concat([Buffer.from('{"cyborg":2,"settings":{"projects":{"items":[{"id":"1","name":"Важный'), Buffer.from([0xff, 0xfe]), Buffer.from('"')]);

describe('повреждённый файл воркспейса', () => {
  it('нет файла - пустой перечень, замечаний и копий нет', async () => {
    await using box = await sandbox('corrupt-');
    const o = await open(box);
    try {
      assert.deepEqual(await o.kernel.run('projects.load'), { projects: [], lastProjectId: null, problem: null });
      assert.deepEqual(await copies(box), []);
    } finally {
      await close(o);
    }
  });

  it('повреждённый JSON: окно живо, плагин и сосед активны, проекты пусты, копия с теми же байтами, исходный файл цел', async () => {
    await using box = await sandbox('corrupt-');
    const file = path.join(box.root, 'team.cyborg.json');
    await writeFile(file, garbage);
    const o = await open(box);
    try {
      assert.deepEqual([...o.kernel.active].sort(), ['projects', 'reader']);
      assert.equal(await o.kernel.run('reader.ping'), 'pong');
      assert.deepEqual(await o.kernel.run('projects.load'), { projects: [], lastProjectId: null, problem: null });
      const [copy] = await copies(box);
      assert.ok(copy, 'копии .corrupt-<время> нет');
      assert.ok((await readFile(path.join(box.root, copy))).equals(garbage), 'копия совпадает с файлом по байтам');
      assert.ok((await readFile(file)).equals(garbage), 'исходный файл не тронут');
      assert.match(o.ws.problems.join('\n'), /копия - team\.cyborg\.json\.corrupt-/);
    } finally {
      await close(o);
    }
  });

  it('плагин сообщает причину: сохранение отказано, файл и копия те же, проблема доступна виду и назвать место копии', async () => {
    await using box = await sandbox('corrupt-');
    const file = path.join(box.root, 'team.cyborg.json');
    await writeFile(file, garbage);
    const o = await open(box);
    try {
      const repo = box.path('a');
      await writeFile(box.path('x'), '');
      await assert.rejects(
        o.kernel.run('projects.save', { projects: [{ id: '1', name: 'п', description: '', repos: [repo] }], lastProjectId: null }),
        /Файл проектов повреждён .*проекты не загружены.*<файл>\.corrupt-<время>/s,
      );
      const problem = (await o.kernel.run('projects.problem')) as { kind: string; detail: string; text: string } | null;
      assert.equal(problem?.kind, 'corrupt');
      assert.ok(problem?.detail);
      assert.match(problem?.text ?? '', /положите её на место файла воркспейса/);
      const loaded = (await o.kernel.run('projects.load')) as LoadReply;
      assert.deepEqual(loaded.projects, [], 'сохранённого в памяти нет: отказ откатил список');
      assert.equal(loaded.problem?.kind, 'corrupt');
      assert.ok((await readFile(file)).equals(garbage), 'save поверх повреждённого не теряет исходные байты');
      assert.equal((await copies(box)).length, 1);
    } finally {
      await close(o);
    }
  });

  for (const [name, text] of [
    ['корень - массив', '[]'],
    ['корень - null', 'null'],
    ['корень - число', '7'],
    ['пустой файл', ''],
  ] as const) {
    it(`неверная форма (${name}) - как повреждение: копия, пустой перечень, запись отказана`, async () => {
      await using box = await sandbox('corrupt-');
      await writeFile(path.join(box.root, 'team.cyborg.json'), text);
      const o = await open(box);
      try {
        assert.deepEqual(await o.kernel.run('projects.load'), { projects: [], lastProjectId: null, problem: null });
        assert.equal(await readFile(path.join(box.root, (await copies(box))[0] ?? 'нет'), 'utf8'), text);
        await assert.rejects(o.kernel.run('projects.save', { projects: [], lastProjectId: null }), /Файл проектов повреждён/);
        assert.equal(await readFile(o.file, 'utf8'), text);
      } finally {
        await close(o);
      }
    });
  }

  for (const [name, items] of [
    ['projects.items не массив', '{}'],
    ['проект не объект', '[1]'],
    ['проект null', '[null]'],
    ['у проекта нет имени', '[{"id":"1","repos":[]}]'],
  ] as const) {
    it(`разобранный файл не в форме раздела (${name}): отказ только плагину, причина в журнале, сосед работает`, async () => {
      await using box = await sandbox('corrupt-');
      const text = `{"cyborg":2,"settings":{"projects":{"$version":1,"items":${items}}}}`;
      await writeFile(path.join(box.root, 'team.cyborg.json'), text);
      const o = await open(box);
      try {
        assert.deepEqual(o.kernel.active, ['reader']);
        const refusal = o.kernel.journal.find((e) => e.kind === 'config' && e.pluginId === 'projects');
        assert.ok(refusal && 'result' in refusal && refusal.result.status === 'invalid', 'причина отказа не записана в журнал');
        assert.equal(await o.kernel.run('reader.ping'), 'pong');
        assert.equal(await readFile(o.file, 'utf8'), text, 'файл не переписан');
      } finally {
        await close(o);
      }
    });
  }

  it('многократное открытие того же файла копий не плодит; изменённая порча - новая копия, прежняя не тронута', async () => {
    await using box = await sandbox('corrupt-');
    const file = path.join(box.root, 'team.cyborg.json');
    await writeFile(file, '{one');
    for (let i = 0; i < 3; i++) await close(await open(box));
    assert.equal((await copies(box)).length, 1);
    await writeFile(file, '{two');
    await close(await open(box));
    const all = await copies(box);
    assert.equal(all.length, 2);
    assert.deepEqual(
      (await Promise.all(all.map((n) => readFile(path.join(box.root, n), 'utf8')))).sort(),
      ['{one', '{two'],
    );
  });

  const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;
  it('файл не читается (права): плагин активен, запись отказана с причиной, файл не тронут, доступ вернули - запись работает', { skip: canChmod ? false : 'нужны POSIX-права и не root: chmod 000 не закрывает файл от root и в Windows' }, async () => {
    await using box = await sandbox('corrupt-');
    const file = path.join(box.root, 'team.cyborg.json');
    const text = JSON.stringify({ cyborg: 2, plugins: {}, settings: {} });
    await writeFile(file, text);
    await chmod(file, 0o000);
    let o: Open | undefined;
    try {
      o = await open(box);
      assert.deepEqual([...o.kernel.active].sort(), ['projects', 'reader']);
      await assert.rejects(o.kernel.run('projects.save', { projects: [{ id: '1', name: 'п', description: '', repos: [] }], lastProjectId: null }), /Проекты не сохранены/);
      const problem = (await o.kernel.run('projects.problem')) as { kind: string; text: string } | null;
      assert.ok(problem && (problem.kind === 'refused' || problem.kind === 'corrupt'), JSON.stringify(problem));
      assert.deepEqual(await copies(box), []);
      await chmod(file, 0o600);
      assert.equal(await readFile(file, 'utf8'), text);
      await o.kernel.run('projects.save', { projects: [{ id: '1', name: 'п', description: '', repos: [] }], lastProjectId: null });
      assert.equal(((await o.kernel.run('projects.problem')) as unknown), null, 'после удачной записи замечание снято');
    } finally {
      await chmod(file, 0o600);
      if (o) await close(o);
    }
  });
});

describe('правка файла воркспейса извне', () => {
  it('человек поправил проекты в файле: перечень, корни и выбор пересчитываются без перезапуска; убранный выбранный проект снимает выбор', async () => {
    await using box = await sandbox('corrupt-');
    const [a, b] = [await makeDir(box, 'a'), await makeDir(box, 'b')] as [string, string];
    const file = path.join(box.root, 'team.cyborg.json');
    const doc = (id: string, repo: string) => JSON.stringify({ cyborg: 2, settings: { projects: { $version: 1, items: [{ id, name: `проект ${id}`, description: '', repos: [repo] }] } } });
    await writeFile(file, doc('1', a));
    const o = await open(box);
    try {
      assert.equal(((await o.kernel.run('projects.load')) as LoadReply).projects[0]?.id, '1');
      await o.kernel.run('projects.select', '1');
      await writeFile(file, doc('2', b));
      await o.kernel.reloadSections('config', await o.ws.config.reload());
      const loaded = (await o.kernel.run('projects.load')) as LoadReply;
      assert.deepEqual(loaded.projects.map((p) => p.id), ['2']);
      assert.equal(loaded.lastProjectId, null, 'выбранный проект убран из файла');
    } finally {
      await close(o);
    }
  });
});
