// `onChange` вместо опроса раз в 3 с: оповещение при изменении индекса, головы и упакованных ссылок, без оповещения о правке файлов; worktree и подмодуль;
// склейка одновременных `status`; отписка и выгрузка снимают слежение.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pause, repo, rig, until } from './kit.ts';

describe('git: onChange', () => {
  it('срабатывает на add, commit и checkout снаружи, правка файла рабочего дерева и посторонние имена в .git его не будят', async () => {
    using r = repo({ files: { 'a.txt': 'a\n' }, branches: ['feat'] });
    await using t = await rig({ repos: [r.dir], countWatches: true });
    const w = await t.watch(r.dir);
    await until('слежение за .git открыто', () => t.watches.opened.includes(path.join(r.dir, '.git')));

    r.write('a.txt', 'x\n');
    await pause(400);
    assert.equal(w.count(), 0, 'правка файла: индекс не менялся, оповещения нет');
    // Имя в .git вне перечня (fetch, редактор сообщения коммита): отметок дерева оно не меняет.
    r.write('.git/FETCH_HEAD', 'x\n');
    await pause(400);
    assert.equal(w.count(), 0, 'FETCH_HEAD не входит в перечень имён');

    r.git('add', 'a.txt');
    await until('оповещение после add', () => w.count() > 0);
    const afterAdd = w.count();
    r.git('commit', '-q', '-m', 'second');
    await until('оповещение после commit', () => w.count() > afterAdd);
    const afterCommit = w.count();
    r.git('checkout', '-q', 'feat');
    await until('оповещение после checkout', () => w.count() > afterCommit);
    assert.equal((await t.git.status(r.dir))?.branch, 'feat');
    assert.equal(await t.git.branch(r.dir), 'feat');
    t.clean();
  });

  it('смена ветки самим плагином тоже оповещает подписчиков: дерево перерисуется без опроса', async () => {
    using r = repo({ branches: ['feature'] });
    await using t = await rig({ repos: [r.dir], countWatches: true });
    const w = await t.watch(r.dir);
    await until('слежение за .git открыто', () => t.watches.live() === 1);
    assert.deepEqual(await t.git.switch(r.dir, 'feature'), {});
    await until('оповещение после switch', () => w.count() > 0);
  });

  it('чтение статуса само не будит слежение: --no-optional-locks не пишет индекс (иначе дерево зациклилось бы на своих опросах)', async () => {
    using r = repo({ files: { 'a.txt': 'a\n' } });
    await using t = await rig({ repos: [r.dir], countWatches: true });
    const w = await t.watch(r.dir);
    await until('слежение за .git открыто', () => t.watches.live() === 1);
    r.write('a.txt', 'a\n');
    // Файл переписан с тем же содержимым: stat расходится, индекс при опросе без --no-optional-locks был бы обновлён.
    for (let i = 0; i < 5; i++) await t.git.status(r.dir);
    await pause(400);
    assert.equal(w.count(), 0);
    // Контроль: обычный git status обновляет индекс и будит слежение - иначе проверка выше ничего бы не доказывала.
    execFileSync('git', ['status', '--porcelain'], { cwd: r.dir, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    await until('контроль: git status без защиты обновил индекс', () => w.count() > 0);
  });

  it('несколько подписчиков одного репозитория делят одно слежение; последняя отписка и выгрузка плагина его снимают', async () => {
    using r = repo();
    await using t = await rig({ repos: [r.dir], countWatches: true });
    const a = await t.watch(r.dir);
    const b = await t.watch(r.dir);
    await until('слежение открыто', () => t.watches.live() === 1);
    assert.equal(t.watches.opened.length, 1, 'одно слежение на репозиторий');
    r.git('commit', '-q', '--allow-empty', '-m', 'one');
    await until('оба подписчика оповещены', () => a.count() > 0 && b.count() > 0);
    a.dispose();
    await pause(100);
    assert.equal(t.watches.live(), 1, 'второй подписчик держит слежение');
    const seen = b.count();
    r.git('commit', '-q', '--allow-empty', '-m', 'two');
    await until('оставшийся подписчик оповещён', () => b.count() > seen);
    b.dispose();
    await until('слежение снято после последней отписки', () => t.watches.live() === 0);
    await t.kernel.disable('git');
    assert.equal(t.watches.live(), 0);
  });

  it('выгрузка плагина снимает слежение за деревом (отметки) и подписки потребителей', async () => {
    using r = repo({ files: { 'a.txt': 'a\n' } });
    await using t = await rig({ repos: [r.dir], countWatches: true });
    await t.tree.marks(r.dir);
    const w = await t.watch(r.dir);
    await until('слежение открыто', () => t.watches.live() === 1);
    assert.equal(t.watches.opened.length, 1, 'слежение дерева и onChange делят одно');
    assert.ok(w);
    await t.kernel.disable('git');
    await until('слежение снято при выгрузке', () => t.watches.live() === 0);
  });

  it('worktree: .git - файл с gitdir, слежение идёт за каталогом worktree внутри основного .git; статус и оповещения работают', async () => {
    using main = repo({ files: { 'a.txt': 'a\n' } });
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'cyborg-wt-')));
    try {
      const wt = path.join(base, 'wt');
      main.git('worktree', 'add', '-q', '-b', 'wt', wt);
      await using t = await rig({ repos: [main.dir, wt], countWatches: true });
      const w = await t.watch(wt);
      const gitdir = path.join(main.dir, '.git', 'worktrees', 'wt');
      await until('слежение за gitdir worktree открыто', () => t.watches.opened.includes(gitdir));
      assert.equal((await t.git.status(wt))?.branch, 'wt');

      writeFileSync(path.join(wt, 'n.txt'), 'n\n');
      execFileSync('git', ['-C', wt, 'add', 'n.txt'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
      await until('оповещение после add в worktree', () => w.count() > 0);
      assert.deepEqual((await t.git.status(wt))?.changes.map((c) => `${c.index}${c.worktree} ${c.path}`), ['A  n.txt']);
      t.clean();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('worktree, основной репозиторий которого вне workspace: слежения нет, ошибки нет, status отвечает', async () => {
    using main = repo({ files: { 'a.txt': 'a\n' } });
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'cyborg-wt-')));
    try {
      const wt = path.join(base, 'wt');
      main.git('worktree', 'add', '-q', '-b', 'wt', wt);
      // workspace - только worktree: `.git` указывает в каталог основного репозитория, который плагину читать нельзя.
      await using t = await rig({ repos: [wt], countWatches: true });
      await t.watch(wt);
      assert.equal((await t.git.status(wt))?.branch, 'wt', 'status работает: git читает свой каталог сам');
      await pause(200);
      assert.equal(t.watches.opened.length, 0, 'gitdir вне области чтения: слежения нет');
      assert.deepEqual(t.logs.filter((l) => /onChange/.test(l)), []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('подмодуль: .git - файл с относительным gitdir внутри .git/modules родителя', async () => {
    using inner = repo({ files: { 'in.txt': 'i\n' } });
    using outer = repo({ files: { 'a.txt': 'a\n' } });
    await using t = await rig({ repos: [outer.dir], countWatches: true });
    outer.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner.dir, 'sub');
    const sub = path.join(outer.dir, 'sub');
    await t.watch(sub);
    await until('слежение за каталогом подмодуля открыто', () => t.watches.opened.includes(path.join(outer.dir, '.git', 'modules', 'sub')));
  });

  it('слежение больше чем за 16 репозиториями не открывается: причина в журнале, остальные работают', async () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'cyborg-many-')));
    try {
      const dirs: string[] = [];
      for (let i = 0; i < 17; i++) {
        const dir = path.join(base, `r${String(i)}`);
        mkdirSync(path.join(dir, '.git'), { recursive: true });
        dirs.push(dir);
      }
      await using t = await rig({ repos: dirs, countWatches: true });
      for (const dir of dirs) await t.watch(dir);
      await until('отказ семнадцатому', () => t.logs.some((l) => l.includes('больше чем за 16')));
      await until('открыто ровно 16 слежений', () => t.watches.live() === 16);
      await pause(100);
      assert.equal(t.watches.live(), 16);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('git: параллельные запросы', () => {
  it('параллельные status одного репозитория склеиваются: не больше двух прогонов на пачку, последний видит правку, сделанную во время первого', async () => {
    using r = repo({ files: { 'a.txt': 'a\n' } });
    await using t = await rig({ repos: [r.dir] });
    t.mark();
    const first = t.git.status(r.dir);
    r.write('late.txt', 'x');
    const rest = await Promise.all([1, 2, 3, 4, 5, 6].map(() => t.git.status(r.dir)));
    await first;
    const statusRuns = t.since().filter((c) => c.includes(' status '));
    assert.ok(statusRuns.length <= 2, `запусков status: ${String(statusRuns.length)}`);
    for (const s of rest) assert.ok(s?.changes.some((c) => c.path === 'late.txt'), 'вызов, начатый после правки, не вернул ответ старше правки');
  });
});
