// Канал `fs:list` -> команда `files.list` и граница `workspace` (часть `allowed-paths.test.ts` ai-cyborg, касающаяся дерева): дерево не выходит за репозитории проектов -
// ни `..`, ни символьной ссылкой, ни корнем файловой системы; корни считаются при каждом вызове.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CHANNELS } from '../index.ts';
import { cleanPath, sortEntries } from '../listing.ts';
import { files, repo, rig } from './kit.ts';

interface Entry {
  name: string;
  kind: string;
  link?: true;
}
const names = (list: unknown): string[] => (list as Entry[]).map((e) => `${e.kind === 'dir' ? '/' : ''}${e.name}`);

/** Каталог вне проекта: «сосед с общим префиксом» и цель ссылок наружу. */
function outside(prefix: string): { dir: string; [Symbol.dispose](): void } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  return { dir, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('files.list (fs:list)', () => {
  it('канал владельца заменён командой, соответствие записано в CHANNELS', () => {
    assert.deepEqual(CHANNELS, { 'fs:list': 'files.list' });
  });

  it('каталоги раньше файлов, внутри групп по имени; .git не показан; файлы и каталоги с точкой в имени показаны', async () => {
    using r = repo({ files: { 'b.txt': 'b', 'A.txt': 'a' } });
    files(r.dir, { 'z/inner.txt': '1', 'a/inner.txt': '1', '.hidden': 'h', 'm/.keep': '' });
    await using t = await rig();
    await t.setProject([r.dir]);
    const list = await t.run('files.list', r.dir);
    assert.deepEqual(names(list), ['/a', '/m', '/z', '.hidden', 'A.txt', 'b.txt']);
    assert.equal((list as Entry[]).some((e) => e.name === '.git'), false);
  });

  it('sortEntries: каталоги раньше, localeCompare внутри группы, исходный список не меняется', () => {
    const input = [
      { name: 'b', kind: 'file' as const },
      { name: 'a', kind: 'file' as const },
      { name: 'z', kind: 'dir' as const },
    ];
    assert.deepEqual(sortEntries(input).map((e) => e.name), ['z', 'a', 'b']);
    assert.deepEqual(input.map((e) => e.name), ['b', 'a', 'z']);
  });

  it('ссылка на каталог внутри проекта - каталог (раскрывается), на файл - файл; цель вне проекта и висячая - ссылка без цели', async () => {
    using r = repo({ files: { 'real/x.txt': 'x', 'f.txt': 'f' } });
    using out = outside('cyborg-files-out-');
    mkdirSync(path.join(out.dir, 'secret'));
    writeFileSync(path.join(out.dir, 'secret', 's.txt'), 's');
    symlinkSync(path.join(r.dir, 'real'), path.join(r.dir, 'to-dir'));
    symlinkSync(path.join(r.dir, 'f.txt'), path.join(r.dir, 'to-file'));
    symlinkSync(path.join(out.dir, 'secret'), path.join(r.dir, 'to-outside'));
    symlinkSync(path.join(r.dir, 'gone'), path.join(r.dir, 'dangling'));
    await using t = await rig();
    await t.setProject([r.dir]);
    const list = (await t.run('files.list', r.dir)) as Entry[];
    const by = Object.fromEntries(list.map((e) => [e.name, e]));
    assert.deepEqual(by['to-dir'], { name: 'to-dir', kind: 'dir', link: true });
    assert.deepEqual(by['to-file'], { name: 'to-file', kind: 'file', link: true });
    assert.deepEqual(by['to-outside'], { name: 'to-outside', kind: 'link' });
    assert.deepEqual(by['dangling'], { name: 'dangling', kind: 'link' });
    assert.deepEqual(names(await t.run('files.list', path.join(r.dir, 'to-dir'))), ['x.txt'], 'ссылка внутрь читается как сам каталог');
  });
});

describe('дерево не выходит за workspace', () => {
  it('вне проекта, сосед с общим префиксом имени, корень файловой системы и домашний каталог - отказ шлюза, не пустой ответ', async () => {
    using r = repo({ files: { 'a.txt': 'a' } });
    const neighbour = `${r.dir}-evil`;
    mkdirSync(neighbour);
    try {
      await using t = await rig();
      await t.setProject([r.dir]);
      for (const dir of [neighbour, path.dirname(r.dir), '/', '/etc', t.kernel.sandbox.root]) await assert.rejects(t.run('files.list', dir), /вне области|PermissionDenied|нет доступа/i, dir);
    } finally {
      rmSync(neighbour, { recursive: true, force: true });
    }
  });

  it('путь с «..», «.», относительный, пустой, с NUL - отказ до шлюза; строка внутри корня после «..» не принимается', async () => {
    using r = repo({ files: { 'src/a.txt': 'a' } });
    await using t = await rig();
    await t.setProject([r.dir]);
    for (const bad of [`${r.dir}/..`, `${r.dir}/../etc`, `${r.dir}/src/../../etc`, `${r.dir}/./src`, 'src', '', `${r.dir}/a\0b`]) {
      await assert.rejects(t.run('files.list', bad), /файл|путь|строк|абсолют|«\.»|files\.list/i, JSON.stringify(bad));
    }
    await assert.rejects(t.run('files.list', 5), /string|строк|аргумент/i, 'не строка');
    assert.equal(cleanPath(`${r.dir}//src/`, 'x'), `${r.dir}/src`, 'повторные и хвостовые / снимаются');
  });

  it('/repo/link/.. не проходит: строка внутри репозитория, но ядро раскрыло бы её по ссылке наружу', async () => {
    using r = repo({ files: { 'a.txt': 'a' } });
    using out = outside('cyborg-files-out-');
    mkdirSync(path.join(out.dir, 'inner'), { recursive: true });
    writeFileSync(path.join(out.dir, 'top-secret.txt'), 's');
    symlinkSync(path.join(out.dir, 'inner'), path.join(r.dir, 'link'));
    await using t = await rig();
    await t.setProject([r.dir]);
    await assert.rejects(t.run('files.list', `${r.dir}/link/..`));
  });

  it('символьная ссылка внутри репозитория ведёт наружу - каталог по ней закрыт (в ai-cyborg читался), ссылка в дереве остаётся ссылкой', async () => {
    using r = repo({ files: { 'a.txt': 'a' } });
    using out = outside('cyborg-files-out-');
    writeFileSync(path.join(out.dir, 'secret.txt'), 's');
    symlinkSync(out.dir, path.join(r.dir, 'docs'));
    await using t = await rig();
    await t.setProject([r.dir]);
    await assert.rejects(t.run('files.list', path.join(r.dir, 'docs')), /вне области|PermissionDenied|нет доступа/i);
    const root = (await t.view()).roots[0];
    assert.deepEqual(root?.nodes[r.dir]?.find((e) => e[0] === 'docs'), ['docs', 'link', 'untracked', false]);
    await assert.rejects(t.run('files.expand', path.join(r.dir, 'docs')), /ссылк/);
  });

  it('корень проекта назван физическим путём: через символьную ссылку на него дерево читается, путь вне границ - нет', async () => {
    using r = repo({ files: { 'a.txt': 'a' } });
    const alias = `${r.dir}-alias`;
    symlinkSync(r.dir, alias);
    try {
      await using t = await rig();
      await t.setProject([r.dir]);
      assert.deepEqual(names(await t.run('files.list', alias)), ['a.txt']);
    } finally {
      rmSync(alias, { force: true });
    }
  });

  it('корни считаются при каждом вызове: проект добавлен - путь разрешён, репозиторий убран - отказ', async () => {
    using a = repo({ files: { 'a.txt': 'a' } });
    using b = repo({ files: { 'b.txt': 'b' } });
    await using t = await rig();
    await t.setProject([a.dir]);
    await assert.rejects(t.run('files.list', b.dir));
    await t.setProject([a.dir, b.dir]);
    assert.deepEqual(names(await t.run('files.list', b.dir)), ['b.txt']);
    await t.setProject([b.dir]);
    await assert.rejects(t.run('files.list', a.dir));
  });

  it('files.expand и files.open отказывают вне корней показанного дерева, даже если шлюз пустил бы путь', async () => {
    using a = repo({ files: { 'a.txt': 'a' } });
    using b = repo({ files: { 'b.txt': 'b' } });
    await using t = await rig();
    await t.setProject([a.dir, b.dir]);
    await t.view('project');
    // b - второй корень, он свёрнут, но корень показан: путь внутри b допустим только после раскрытия родителя.
    await assert.rejects(t.run('files.expand', path.join(b.dir, 'nope')), /не показан в дереве|не каталог/);
    await assert.rejects(t.run('files.expand', '/etc'), /вне корней/);
    await assert.rejects(t.run('files.open', '/etc/hosts'), /вне корней/);
    await assert.rejects(t.run('files.branches', '/etc'), /вне корней/);
    await assert.rejects(t.run('files.switch', '/etc', 'main'), /вне корней/);
  });
});
