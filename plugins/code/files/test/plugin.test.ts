// Плагин files: состав и права, потребитель `cyborg.tree-decoration` (кратность many) на подставных поставщиках, работа без поставщиков и без соседних плагинов, открытие файла в просмотре.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { PluginContext, TreeMark } from '@cyborg-harness/contracts';
import { checkPlugin } from '@cyborg-harness/core/plugin-check';
import { startKernel, type InlinePlugin } from '@cyborg-harness/testing';
import { files, pause, PLUGIN_DIR, repo, rig, until } from './kit.ts';

const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8')) as {
  permissions: Record<string, unknown>;
  commands: Record<string, { callers?: string }>;
  optional: Record<string, string>;
  consumes: Record<string, string>;
  provides?: unknown;
  requires?: unknown;
  ui: { views: Record<string, { area: string }> };
};

/** Подставной поставщик отметок: кратность many, поставщиков может быть несколько. */
function decorator(id: string, marks: () => TreeMark[]): { plugin: InlinePlugin; fire(root: string): void; asked: string[] } {
  const listeners = new Set<(root: string) => void>();
  const asked: string[] = [];
  return {
    asked,
    fire: (root) => listeners.forEach((l) => l(root)),
    plugin: {
      manifest: { id, version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'cyborg.tree-decoration': '1.0' } },
      module: {
        activate(ctx: PluginContext) {
          ctx.contracts.provide('cyborg.tree-decoration', '1.0', {
            marks: async (root: string) => (asked.push(root), marks()),
            onChange: (listener: (root: string) => void) => (listeners.add(listener), { dispose: () => void listeners.delete(listener) }),
          });
          return undefined;
        },
      },
    },
  };
}

describe('плагин files', () => {
  it('проверка состава: манифест, файлы, правило импортов - без замечаний; право одно - читать workspace, процессов и записи нет', async () => {
    const report = await checkPlugin(PLUGIN_DIR, { ignore: ['dist'], declarationPackages: ['@cyborg-plugins/contracts'] });
    assert.deepEqual(report.problems, []);
    assert.equal(report.permissions.length, 1, report.permissions.join('; '));
    assert.ok(report.permissions[0]?.startsWith('читает файлы'), report.permissions.join('; '));
    assert.deepEqual(Object.keys(manifest.permissions), ['fs.read']);
    assert.equal(manifest.provides, undefined, 'контракты только потребляются: отметки и ветки отдают git и другие');
    assert.equal(manifest.requires, undefined, 'без соседей плагин активен (дерево без проектов, отметок и git)');
  });

  it('потребляет cyborg.tree-decoration и берёт при наличии projects, sessions и git; команды видов закрыты чужим плагинам, вид один - в боковой колонке', () => {
    assert.deepEqual(manifest.consumes, { 'cyborg.tree-decoration': '^1' });
    assert.deepEqual(Object.keys(manifest.optional).sort(), ['cyborg.git', 'cyborg.projects', 'cyborg.sessions']);
    for (const [name, spec] of Object.entries(manifest.commands)) assert.equal(spec.callers ?? 'user', 'user', `${name}: команды вида открыты только человеку`);
    assert.deepEqual(manifest.ui.views['tree']?.area, 'sidebar');
  });

  it('несколько поставщиков отметок: побеждает более значимая; поставщик ушёл - его отметки исчезают, вернулся - появляются; onChange поставщика обновляет дерево', async () => {
    using r = repo({ files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
    let first: TreeMark[] = [{ path: 'a.txt', kind: 'modified' }];
    const one = decorator('deco-one', () => first);
    const two = decorator('deco-two', () => [{ path: 'a.txt', kind: 'conflict' }, { path: 'b.txt', kind: 'added' }]);
    await using t = await rig({ noGit: true, extra: [one.plugin, two.plugin] });
    await t.setProject([r.dir]);
    const marksOf = async (): Promise<Record<string, unknown>> => Object.fromEntries((await t.view()).roots[0]?.nodes[r.dir]?.map((e) => [e[0], e[2]]) ?? []);
    await until('отметки обоих поставщиков', async () => (await marksOf())['a.txt'] === 'conflict' && (await marksOf())['b.txt'] === 'added');
    await t.kernel.disable('deco-two');
    await until('отметки ушедшего поставщика исчезли', async () => (await marksOf())['a.txt'] === 'modified' && (await marksOf())['b.txt'] === null);
    await t.kernel.enable('deco-two');
    await until('вернувшийся поставщик снова виден', async () => (await marksOf())['a.txt'] === 'conflict' && (await marksOf())['b.txt'] === 'added');
    await t.kernel.disable('deco-two');
    first = [{ path: 'b.txt', kind: 'deleted' }];
    one.fire(r.dir);
    await until('onChange поставщика обновил отметки', async () => (await marksOf())['b.txt'] === 'deleted' && (await marksOf())['a.txt'] === null);
    assert.ok([...one.asked, ...two.asked].every((root) => root === r.dir), 'отметки спрашиваются только о корнях дерева');
    t.clean();
  });

  it('без поставщика отметок и без git дерево работает; без проектов - пояснение вместо дерева, команды не падают', async () => {
    await using kernel = await startKernel({ plugins: [PLUGIN_DIR], load: { bundled: ['files'] } });
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'files' });
    const reply = (await kernel.run('files.view')) as { hint: string; roots: unknown[]; scopes: { id: string }[] };
    assert.deepEqual(reply.roots, []);
    assert.match(reply.hint, /Проектов нет/);
    assert.deepEqual(reply.scopes.map((s) => s.id), ['project']);
    await assert.rejects(kernel.run('files.expand', '/tmp/x'), /вне корней/);
    await assert.rejects(kernel.run('files.list', '/tmp'), /вне области|PermissionDenied|нет доступа/i, 'без проектов workspace пуст: читать нечего');
    assert.deepEqual(kernel.journal.filter((e) => e.kind === 'failed' || e.kind === 'invalid' || e.kind === 'rejected'), []);
  });

  it('файл открывается командой viewer.open через права вызывающего; просмотра нет - отказ словами, а не молчание', async () => {
    using r = repo({ files: { 'a.txt': 'a\n' } });
    await using t = await rig();
    await t.setProject([r.dir]);
    await t.view();
    await t.run('files.open', `${r.dir}/a.txt`);
    assert.deepEqual(t.viewer.opened, [`${r.dir}/a.txt`]);
    await using bare = await rig({ noViewer: true });
    await bare.setProject([r.dir]);
    await bare.view();
    await assert.rejects(bare.run('files.open', `${r.dir}/a.txt`), /файл не открыт/);
  });

  it('все изменения вида уходят одним сообщением на ход цикла событий: вид просит состояние сам, текст сообщения - только номер версии', async () => {
    using r = repo({ files: { 'a.txt': 'a\n' } });
    await using t = await rig();
    await t.setProject([r.dir]);
    await t.view();
    await pause(100);
    assert.ok(t.sent.length > 0);
    for (const message of t.sent) assert.deepEqual(Object.keys(message as object), ['changed']);
    const versions = t.sent.map((m) => (m as { changed: number }).changed);
    assert.deepEqual(versions, versions.toSorted((a, b) => a - b), 'версии растут');
  });
});
