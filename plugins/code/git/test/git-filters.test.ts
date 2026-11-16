// Перенос git-filters.test.ts ai-cyborg: `status` не запускает драйверы фильтров из конфига репозитория и вложенных репозиториев.
// Те же репозитории и те же утверждения о маркере «фильтр выполнен»; отличие одно: где ai-cyborg отвечал пустым статусом (не репозиторий, ключи собрать не вышло),
// `status` отвечает `null` (не репозиторий) или отказом (сбор ключей не удался): пустой ответ скрыл бы от потребителя, что статус неизвестен.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { letters, repo, rig, type Repo } from './kit.ts';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
/** Настоящий git вне плагина: подготовка репозиториев (в том числе вложенных, куда `fixtureRepo` не заглядывает). */
function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', '-C', cwd, ...args], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, '.gitattributes'), '* filter=x\n');
  writeFileSync(path.join(dir, 'f.txt'), 'a\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
}

// Фильтр запускается только у файла с изменившимся mtime при прежних размере и содержимом.
function touchOld(file: string | Buffer): void {
  const old = new Date('2020-01-01T00:00:00Z');
  utimesSync(file, old, old);
}

/** Маркер, который создаёт драйвер фильтра, и сам драйвер (скрипт-«cat»). */
function driver(dir: string): { marker: string; script: string } {
  const marker = path.join(dir, 'filter-ran');
  const script = path.join(dir, 'filter.sh');
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
  chmodSync(script, 0o755);
  return { marker, script };
}

const filterRepo = (): Repo => repo({ files: { '.gitattributes': '* filter=x\n', 'f.txt': 'a\n' } });

describe('git: status не запускает фильтры из конфига репозитория', () => {
  for (const key of ['clean', 'process']) {
    it(`status не запускает filter.x.${key} из конфига репозитория`, async () => {
      using r = filterRepo();
      await using t = await rig({ repos: [r.dir] });
      const { marker, script } = driver(t.box.root);
      r.git('config', `filter.x.${key}`, script);
      r.git('config', 'filter.x.required', 'true');
      touchOld(path.join(r.dir, 'f.txt'));
      r.write('new.txt', 'n\n');
      // Контроль: без перекрытия этот же git status запускает драйвер - иначе проверка ниже ничего бы не доказывала.
      try {
        execFileSync('git', ['status', '--porcelain'], { cwd: r.dir, stdio: 'ignore', env: ENV });
      } catch {
        // `required` у фильтра, не говорящего по протоколу, роняет и сам контроль: важен только маркер.
      }
      assert.ok(existsSync(marker), 'контроль: без защиты драйвер фильтра выполняется');
      rmSync(marker, { force: true });
      touchOld(path.join(r.dir, 'f.txt'));

      const status = await t.git.status(r.dir);

      assert.equal(existsSync(marker), false, 'драйвер фильтра выполнен');
      assert.ok(status);
      assert.equal(letters(status)['new.txt'], '?');
    });
  }

  it('status не запускает фильтр из конфига вложенного репозитория (подмодуль)', async () => {
    using inner = filterRepo();
    using outer = repo({ files: { 'a.txt': 'a\n' } });
    await using t = await rig({ repos: [outer.dir] });
    const { marker, script } = driver(t.box.root);
    sh(outer.dir, 'submodule', 'add', '-q', inner.dir, 'sub');
    sh(outer.dir, 'commit', '-q', '-m', 'sub');
    sh(path.join(outer.dir, 'sub'), 'config', 'filter.x.clean', script);
    touchOld(path.join(outer.dir, 'sub', 'f.txt'));

    await t.git.status(outer.dir);

    assert.equal(existsSync(marker), false, 'драйвер фильтра вложенного репозитория выполнен');
  });

  it('status вне репозитория отвечает null: пустого статуса, как у ai-cyborg, нет - «не репозиторий» не смешивается с «чисто»', async () => {
    await using t = await rig();
    assert.equal(await t.git.status(t.plain), null);
  });

  it('status перекрывает фильтр с U+2028 в имени подсекции', async () => {
    using r = filterRepo();
    await using t = await rig({ repos: [r.dir] });
    const { marker, script } = driver(t.box.root);
    const name = 'x y';
    r.write('.gitattributes', `f.txt filter=${name}\n`);
    r.git('commit', '-q', '-am', 'attrs');
    r.git('config', `filter.${name}.clean`, script);
    touchOld(path.join(r.dir, 'f.txt'));

    const status = await t.git.status(r.dir);

    assert.equal(existsSync(marker), false, 'драйвер фильтра выполнен');
    assert.deepEqual(status?.changes, []);
  });

  for (const failing of ['--get-regexp', 'ls-files']) {
    it(`при ошибке ${failing} status отказывает (ai-cyborg: пустой статус) и не запускает git status`, async () => {
      using r = filterRepo();
      await using t = await rig({ repos: [r.dir] });
      const { marker, script } = driver(t.box.root);
      r.git('config', 'filter.x.clean', script);
      touchOld(path.join(r.dir, 'f.txt'));
      r.write('new.txt', 'n\n');
      t.failOn(failing);

      await assert.rejects(t.git.status(r.dir), /git (config|ls-files): код 2/);

      assert.equal(existsSync(marker), false, 'драйвер фильтра выполнен');
      assert.deepEqual(t.runs().filter((c) => ` ${c} `.includes(' status ')), [], 'git status запущен без перекрытия');
    });
  }

  // Пустой каталог незаполненного подмодуля - обычный итог clone без --recurse-submodules.
  it('status не вызывает git для незаполненного подмодуля', async () => {
    using r = filterRepo();
    await using t = await rig({ repos: [r.dir] });
    const head = r.git('rev-parse', 'HEAD').trim();
    r.git('update-index', '--add', '--cacheinfo', `160000,${head},sub`);
    r.git('commit', '-q', '-m', 'gitlink');
    const sub = path.join(r.dir, 'sub');
    mkdirSync(sub);

    await t.git.status(r.dir);

    assert.deepEqual(t.calls().filter((c) => c.cwd === sub || c.args.includes(sub)), [], 'вызов git для незаполненного подмодуля');
  });

  it('при имени подсекции не в UTF-8 status отказывает (ai-cyborg: пустой статус) и не запускает фильтр', async () => {
    using r = filterRepo();
    await using t = await rig({ repos: [r.dir] });
    const { marker, script } = driver(t.box.root);
    r.write('.gitattributes', Buffer.concat([Buffer.from('f.txt filter=p'), Buffer.from([0xff]), Buffer.from('q\n')]));
    r.git('commit', '-q', '-am', 'attrs');
    appendFileSync(path.join(r.dir, '.git', 'config'), Buffer.concat([Buffer.from('[filter "p'), Buffer.from([0xff]), Buffer.from(`q"]\n\tclean = ${script}\n`)]));
    touchOld(path.join(r.dir, 'f.txt'));
    r.write('new.txt', 'n\n');

    await assert.rejects(t.git.status(r.dir), /не в UTF-8/);
    assert.equal(existsSync(marker), false, 'драйвер фильтра выполнен');
  });

  // Цепочка заполненных репозиториев: каждый хранит gitlink на вложенный, как заполненный подмодуль.
  function makeChain(root: string, levels: number): string {
    let dir = root;
    makeRepo(dir);
    for (let i = 0; i < levels; i++) {
      const head = sh(dir, 'rev-parse', 'HEAD').trim();
      sh(dir, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`);
      sh(dir, 'commit', '-q', '-m', 'gitlink');
      dir = path.join(dir, 'sub');
      makeRepo(dir);
    }
    return dir;
  }

  it('status перекрывает фильтр репозитория на глубине 3', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'cyborg-git-chain-'));
    try {
      const top = path.join(realpathSync(base), 'repo');
      const { marker, script } = driver(realpathSync(base));
      const deepest = makeChain(top, 3);
      await using t = await rig({ repos: [top] });
      sh(deepest, 'config', 'filter.x.clean', script);
      touchOld(path.join(deepest, 'f.txt'));

      await t.git.status(top);

      assert.equal(existsSync(marker), false, 'драйвер фильтра выполнен');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('при вложенности глубже предела status отказывает (ai-cyborg: пустой статус)', { timeout: 60_000 }, async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'cyborg-git-chain-'));
    try {
      const top = path.join(realpathSync(base), 'repo');
      makeChain(top, 12);
      writeFileSync(path.join(top, 'new.txt'), 'n\n');
      await using t = await rig({ repos: [top] });

      await assert.rejects(t.git.status(top), /вложенность репозиториев глубже предела/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // Gitlink заводится через index-info: путь с байтом 0xff в аргумент командной строки строкой не передать.
  function addGitlink(top: string, inner: string, relPath: Buffer): void {
    const sha = sh(inner, 'rev-parse', 'HEAD').trim();
    execFileSync('git', ['-C', top, 'update-index', '--add', '-z', '--index-info'], { input: Buffer.concat([Buffer.from(`160000 ${sha}\t`), relPath, Buffer.from('\0')]), env: ENV });
  }

  function repoWithPopulatedSub(base: string, relPath: Buffer, script: string): string {
    const inner = path.join(base, 'inner');
    makeRepo(inner);
    sh(inner, 'config', 'filter.x.clean', script);
    touchOld(path.join(inner, 'f.txt'));
    const top = path.join(base, 'repo');
    mkdirSync(top);
    sh(top, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(top, 'a.txt'), 'a\n');
    addGitlink(top, inner, relPath);
    renameSync(Buffer.from(inner), Buffer.concat([Buffer.from(`${top}/`), relPath]));
    return top;
  }

  it('status перекрывает фильтр заполненного подмодуля с именем на две точки', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'cyborg-git-dots-'));
    try {
      const { marker, script } = driver(realpathSync(base));
      const top = repoWithPopulatedSub(realpathSync(base), Buffer.from('..x'), script);
      await using t = await rig({ repos: [top] });

      await t.git.status(top);

      assert.equal(existsSync(marker), false, 'драйвер фильтра подмодуля ..x выполнен');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // APFS (macOS) отвергает имена не в UTF-8 с EILSEQ: фикстуру там не построить, а проверяемое поведение git от ФС не зависит.
  const acceptsNonUtf8Names = (): boolean => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cyborg-utf8-'));
    try {
      writeFileSync(Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0x70, 0xff, 0x71])]), '');
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EILSEQ') return false;
      throw e;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('status с подмодулем по пути не в UTF-8 не запускает его фильтр (отказывает: ai-cyborg отвечал пустым статусом)', { skip: acceptsNonUtf8Names() ? false : 'файловая система не допускает имена файлов не в UTF-8 (EILSEQ)' }, async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'cyborg-git-utf8-'));
    try {
      const { marker, script } = driver(realpathSync(base));
      const top = repoWithPopulatedSub(realpathSync(base), Buffer.from([0x70, 0xff, 0x71]), script);
      await using t = await rig({ repos: [top] });

      await assert.rejects(t.git.status(top), /путь вложенного репозитория не в UTF-8/);

      assert.equal(existsSync(marker), false, 'драйвер фильтра подмодуля выполнен');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('status не перекрывает фильтр из глобального конфига: он доверенный', async () => {
    using r = filterRepo();
    await using t = await rig({ repos: [r.dir] });
    const { marker, script } = driver(t.box.root);
    // HOME плагина - каталог набора: его `.gitconfig` и есть глобальный конфиг пользователя.
    writeFileSync(path.join(t.box.root, '.gitconfig'), `[filter "x"]\n\tclean = ${script}\n`);
    touchOld(path.join(r.dir, 'f.txt'));

    await t.git.status(r.dir);

    assert.equal(existsSync(marker), true, 'доверенный глобальный фильтр перекрыт');
  });

  it('status перекрывает фильтр из worktree-конфига', async () => {
    using r = filterRepo();
    await using t = await rig({ repos: [r.dir] });
    const { marker, script } = driver(t.box.root);
    r.git('config', 'extensions.worktreeConfig', 'true');
    r.git('config', '--worktree', 'filter.x.clean', script);
    touchOld(path.join(r.dir, 'f.txt'));

    await t.git.status(r.dir);

    assert.equal(existsSync(marker), false, 'драйвер фильтра из worktree-конфига выполнен');
  });

  it('перекрытие не мешает видеть изменения: `required = true` у фильтра, который не запустили, не роняет status, а правка файла видна', async () => {
    using r = filterRepo();
    await using t = await rig({ repos: [r.dir] });
    const { marker, script } = driver(t.box.root);
    r.git('config', 'filter.x.clean', script);
    r.git('config', 'filter.x.required', 'true');
    r.write('f.txt', 'b\n');
    const status = await t.git.status(r.dir);
    assert.deepEqual(status?.changes.map((c) => `${c.index}${c.worktree} ${c.path}`), [' M f.txt']);
    assert.equal(existsSync(marker), false);
    const runs = t.runs();
    assert.equal(runs.length, 3, 'config, ls-files, status');
    assert.ok(runs.slice(0, 2).some((c) => c.includes('config --show-scope --null --name-only --get-regexp')));
    assert.ok(runs.slice(0, 2).some((c) => c.endsWith('ls-files --stage -z')));
    assert.ok(runs[2]?.endsWith(' status --porcelain=v1 -z --branch --untracked-files=all'));
  });
});
