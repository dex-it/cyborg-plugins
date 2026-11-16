// Дерево на событиях настоящего `fs.watch` ядра (macOS: FSEvents, Linux: inotify; события приходят позже возврата `watch`, пачками, а при лавине часть имён теряется), без опроса.
// Каждый тест, который меняет файлы сразу после постановки слежения, сначала «взводит» его пробной записью (arm): без этого правка в первые миллисекунды терялась бы. Разбор событий
// по узлам проверяет model.test.ts на виртуальной файловой системе, здесь - что реальные события до него доходят и дерево сходится с диском.

import assert from 'node:assert/strict';
import { readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ViewReply } from '../protocol.ts';
import { files, pause, repo, rig, until, type Repo, type Rig } from './kit.ts';

/** Ждёт, пока слежение за корнем начнёт доставлять события: пробный файл создаётся и удаляется, пока дерево не отметит пачку. */
async function arm(t: Rig, r: Repo): Promise<void> {
  const probe = path.join(r.dir, '.arm-probe');
  const end = Date.now() + 15_000;
  const batches = async (): Promise<number> => ((await t.run('files.stats')) as { batches: number }).batches;
  const start = await batches();
  let i = 0;
  while ((await batches()) === start) {
    if (Date.now() > end) assert.fail('слежение не отозвалось за 15 с');
    files(r.dir, { '.arm-probe': String(i++) });
    await pause(100);
  }
  rmSync(probe, { force: true });
  await pause(450);
}

const names = (reply: ViewReply, dir: string): string[] => reply.roots.flatMap((x) => x.nodes[dir]?.map((e) => e[0]) ?? []);

describe('события fs.watch вместо опроса', () => {
  it('слежение за раскрытым корнем одно и рекурсивное; в простое ни одного вызова шлюза; свёрнутый корень без слежения', async () => {
    using a = repo({ files: { 'src/a.ts': 'a\n' } });
    using b = repo({ files: { 'b.ts': 'b\n' } });
    await using t = await rig({ countWatches: true });
    await t.setProject([a.dir, b.dir]);
    await t.view();
    assert.deepEqual(t.watches.opened.filter((w) => w.path === a.dir || w.path === b.dir), [{ path: a.dir, recursive: true }], 'слежение за первым корнем (второй свёрнут); git следит за .git сам');
    await t.run('files.expand', `${a.dir}/src`);
    const before = (await t.run('files.stats')) as Record<string, number>;
    await pause(600);
    assert.deepEqual((await t.run('files.stats')) as Record<string, number>, before, 'без событий дерево не делает ни одного вызова');
    await t.run('files.toggle-root', b.dir);
    assert.ok(t.watches.opened.some((w) => w.path === b.dir && w.recursive), 'раскрытие корня открывает слежение');
    const live = t.watches.live();
    await t.run('files.toggle-root', b.dir);
    assert.equal(t.watches.live(), live - 1, 'свёрнутый корень отпустил слежение');
    t.clean();
  });

  it('выгрузка плагина снимает все слежения дерева', async () => {
    using r = repo();
    await using t = await rig({ countWatches: true });
    await t.setProject([r.dir]);
    await t.view();
    await t.kernel.disable('git');
    const live = t.watches.live();
    assert.ok(live > 0);
    await t.kernel.disable('files');
    await until('слежения сняты', () => t.watches.live() === 0);
  });

  it('создание, переименование и удаление в раскрытых каталогах доходят до дерева; сообщение виду уходит на изменение', async () => {
    using r = repo({ files: { 'src/a.ts': 'a\n', 'docs/readme.md': 'r\n' } });
    await using t = await rig();
    await t.setProject([r.dir]);
    await t.view();
    await t.run('files.expand', `${r.dir}/src`);
    await arm(t, r);
    const sentBefore = t.sent.length;
    files(r.dir, { 'src/created.ts': 'c', 'top.txt': 't' });
    await until('новые имена в дереве', async () => names(await t.view(), `${r.dir}/src`).includes('created.ts') && names(await t.view(), r.dir).includes('top.txt'));
    assert.ok(t.sent.length > sentBefore, 'главная часть сообщила виду');
    renameSync(`${r.dir}/src/created.ts`, `${r.dir}/src/renamed.ts`);
    await until('переименование', async () => {
      const list = names(await t.view(), `${r.dir}/src`);
      return list.includes('renamed.ts') && !list.includes('created.ts');
    });
    rmSync(`${r.dir}/src`, { recursive: true });
    await until('каталог исчез вместе с узлом', async () => {
      const reply = await t.view();
      return !names(reply, r.dir).includes('src') && reply.roots[0]?.nodes[`${r.dir}/src`] === undefined;
    });
    t.clean();
  });

  it('правка в нераскрытом каталоге тянет только отметки: число изменений в корне растёт, каталоги не читаются', async () => {
    using r = repo({ files: { 'deep/er/f.txt': 'f\n', 'a.txt': 'a\n' } });
    await using t = await rig();
    await t.setProject([r.dir]);
    await t.view();
    await arm(t, r);
    const lists = ((await t.run('files.stats')) as { list: number }).list;
    for (let i = 0; i < 30 && (await t.view()).roots[0]?.changes !== 1; i++) {
      files(r.dir, { 'deep/er/f.txt': `v${String(i)}\n` });
      await pause(150);
    }
    const reply = await t.view();
    assert.equal(reply.roots[0]?.changes, 1);
    assert.equal(reply.roots[0]?.nodes[r.dir]?.find((e) => e[0] === 'deep')?.[2], 'changed', 'каталог выше отмечен «внутри есть изменения»');
    assert.equal(((await t.run('files.stats')) as { list: number }).list, lists, 'нераскрытые каталоги не читались');
  });

  it('checkout ветки с десятками каталогов: после тишины раскрытые узлы сходятся с диском, отметки чистые', async () => {
    using r = repo({ files: { 'base.txt': 'b\n' }, branches: [] });
    r.git('checkout', '-q', '-b', 'big');
    for (let d = 0; d < 24; d++) for (let f = 0; f < 4; f++) r.write(`pkg${String(d)}/file${String(f)}.txt`, `${String(d)}${String(f)}\n`);
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'big');
    r.git('checkout', '-q', 'main');
    await using t = await rig();
    await t.setProject([r.dir]);
    await t.view();
    await arm(t, r);
    r.git('checkout', '-q', 'big');
    await until('каталоги появились', async () => names(await t.view(), r.dir).includes('pkg23'), 10_000);
    for (let d = 0; d < 24; d++) await t.run('files.expand', `${r.dir}/pkg${String(d)}`);
    // обратный переход: каталоги исчезают разом, ОС может назвать не все имена
    r.git('checkout', '-q', 'main');
    const disk = (dir: string): string[] => readdirSync(dir).filter((n) => n !== '.git').sort();
    await until(
      'дерево сошлось с диском',
      async () => {
        const reply = await t.view();
        const shown = names(reply, r.dir).sort();
        return JSON.stringify(shown) === JSON.stringify(disk(r.dir)) && Object.keys(reply.roots[0]?.nodes ?? {}).every((d) => statSyncOk(d));
      },
      15_000,
    );
    await until('отметки чистые', async () => (await t.view()).roots[0]?.changes === 0, 10_000);
    t.clean();
  });
});

function statSyncOk(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

describe('слежение недоступно или потеряно', () => {
  it('корень удалён снаружи: дерево помечает его потерянным, остальной проект работает', async () => {
    using a = repo({ files: { 'a.txt': 'a\n' } });
    using b = repo({ files: { 'b.txt': 'b\n' } });
    await using t = await rig();
    await t.setProject([a.dir, b.dir]);
    await t.view();
    await arm(t, a);
    rmSync(a.dir, { recursive: true, force: true });
    await until(
      'корень помечен',
      async () => {
        const reply = await t.view();
        const first = reply.roots.find((x) => x.path === a.dir);
        return first !== undefined && (first.notice !== null || first.error !== null);
      },
      10_000,
    );
    assert.ok((await t.view()).roots.some((x) => x.path === b.dir));
  });
});
