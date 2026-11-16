// Перенос git-branch.test.ts ai-cyborg (ветки и смена ветки, отказ при filter.* и partial clone) с теми же утверждениями; отказы git и защиты приходят `{ error }` (так их отдавал канал git:switch),
// а не исключением. Добавлено то, что стало решением плагина: отказ при работающей сессии (FR-7003, сценарий S12), только репозитории проекта, поставщик сессий без `uses`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fakeSessions, letters, repo, rig } from './kit.ts';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });

describe('git: ветки и смена ветки', () => {
  it('локальные и только удалённые ветки; переключение, в том числе на ветку remote; чужое имя и конфликт - отказ; filter.* и partial clone - отказ', async () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'cyborg-branch-')));
    try {
      const origin = path.join(base, 'origin');
      const dir = path.join(base, 'work');
      sh(base, 'init', '-q', '-b', 'main', 'origin');
      writeFileSync(path.join(origin, 'a.txt'), 'main\n');
      sh(origin, 'add', '.');
      sh(origin, 'commit', '-qm', 'init');
      sh(origin, 'branch', 'remote-only');
      sh(base, 'clone', '-q', origin, dir);
      sh(dir, 'switch', '-qc', 'feature');
      writeFileSync(path.join(dir, 'a.txt'), 'feature\n');
      sh(dir, 'commit', '-qam', 'f');
      await using t = await rig({ repos: [dir] });

      const b = await t.git.branches(dir);
      assert.equal(b.current, 'feature');
      assert.deepEqual([...b.local].sort(), ['feature', 'main']);
      assert.deepEqual(b.remote, ['remote-only']);

      assert.deepEqual(await t.git.switch(dir, 'remote-only'), {});
      assert.equal(await t.git.branch(dir), 'remote-only');
      assert.match((await t.git.switch(dir, '--orphan=x')).error ?? '', /Ветки --orphan=x нет/);

      writeFileSync(path.join(dir, 'a.txt'), 'правка\n');
      const conflict = (await t.git.switch(dir, 'feature')).error;
      assert.ok(conflict && !conflict.startsWith('Command failed'), `причина отказа git: ${String(conflict)}`);
      assert.equal(await t.git.branch(dir), 'remote-only');

      sh(dir, 'checkout', '-q', '--', 'a.txt');
      sh(dir, 'config', 'filter.evil.smudge', 'touch pwned');
      assert.match((await t.git.switch(dir, 'main')).error ?? '', /filter\.evil\.smudge/);
      assert.equal(await t.git.branch(dir), 'remote-only');
      assert.ok(!existsSync(path.join(dir, 'pwned')));

      sh(dir, 'config', '--unset', 'filter.evil.smudge');
      sh(dir, 'config', 'remote.origin.promisor', 'true');
      assert.match((await t.git.switch(dir, 'main')).error ?? '', /remote\.origin\.promisor/);
      sh(dir, 'config', '--unset', 'remote.origin.promisor');
      sh(dir, 'config', 'extensions.partialClone', 'origin');
      assert.match((await t.git.switch(dir, 'main')).error ?? '', /extensions\.partialclone/);
      assert.equal(await t.git.branch(dir), 'remote-only');

      sh(dir, 'config', '--unset', 'extensions.partialClone');
      assert.deepEqual(await t.git.switch(dir, 'main'), {}, 'без опасных ключей ветка снова меняется');
      assert.equal(await t.git.branch(dir), 'main');
      t.clean();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('ключ из пользовательского конфига (filter.*) доверенный и смену ветки не блокирует; ключ репозитория блокирует независимо от регистра имени фильтра', async () => {
    using r = repo({ branches: ['feature'] });
    await using t = await rig({ repos: [r.dir] });
    writeFileSync(path.join(t.box.root, '.gitconfig'), '[filter "lfs"]\n\tsmudge = cat\n');
    assert.deepEqual(await t.git.switch(r.dir, 'feature'), {});
    r.git('config', 'filter.LFS.clean', 'cat');
    assert.match((await t.git.switch(r.dir, 'main')).error ?? '', /filter\.LFS\.clean/);
    assert.equal(await t.git.branch(r.dir), 'feature');
  });

  it('смена ветки не задевает подмодули: submodule.recurse=false перекрывает ключ репозитория', async () => {
    using inner = repo({ files: { 'in.txt': 'i\n' } });
    using outer = repo({ files: { 'a.txt': 'a\n' }, branches: ['other'] });
    await using t = await rig({ repos: [outer.dir] });
    outer.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner.dir, 'sub');
    outer.git('commit', '-q', '-m', 'sub');
    outer.git('config', 'submodule.recurse', 'true');
    const before = sh(path.join(outer.dir, 'sub'), 'rev-parse', 'HEAD');
    assert.deepEqual(await t.git.switch(outer.dir, 'other'), {});
    assert.equal(sh(path.join(outer.dir, 'sub'), 'rev-parse', 'HEAD'), before);
    assert.ok(t.runs().some((c) => c.includes('-c submodule.recurse=false switch -- other')));
  });

  it('ветка, начинающаяся с «-», и несуществующая отклоняются до запуска switch: имя не уходит в git опцией', async () => {
    using r = repo({ branches: ['feature'] });
    await using t = await rig({ repos: [r.dir] });
    t.mark();
    for (const name of ['--orphan=x', '-f', '--detach', 'nope', '']) assert.match((await t.git.switch(r.dir, name)).error ?? '', /Ветки .* нет/, name);
    assert.deepEqual(t.since().filter((c) => c.includes(' switch ')), [], 'git switch не запускался');
    assert.equal(await t.git.branch(r.dir), 'main');
  });

  it('S12: меню веток и смена, правка файла остаётся', async () => {
    using r = repo({ files: { 'a.txt': 'a\n' }, branches: ['parity-wt', 'smk-5-feature'] });
    await using t = await rig({ repos: [r.dir] });
    r.write('a.txt', 'a\nправка\n');
    const branches = await t.git.branches(r.dir);
    assert.deepEqual({ current: branches.current, local: [...branches.local].sort(), remote: branches.remote }, { current: 'main', local: ['main', 'parity-wt', 'smk-5-feature'], remote: [] });
    assert.deepEqual(await t.git.switch(r.dir, 'smk-5-feature'), {});
    assert.equal(await t.git.branch(r.dir), 'smk-5-feature');
    const status = await t.git.status(r.dir);
    assert.equal(status?.branch, 'smk-5-feature');
    assert.deepEqual(status && letters(status), { 'a.txt': 'M' });
    t.clean();
  });
});

describe('git: смена ветки и сессии (FR-7003)', () => {
  it('в репозитории работает сессия - отказ, ветка не меняется; сессия вышла - ветка меняется', async () => {
    using r = repo({ branches: ['feature'] });
    const sessions = fakeSessions('1.2');
    await using t = await rig({ repos: [r.dir], sessions });
    sessions.live.add(r.dir);
    assert.deepEqual(await t.git.switch(r.dir, 'feature'), { error: 'в репозитории работает сессия Claude: веткой управляет она' });
    assert.equal(await t.git.branch(r.dir), 'main');
    assert.deepEqual(sessions.asked, [r.dir]);
    assert.deepEqual(t.runs().filter((c) => c.includes(' switch ')), [], 'git switch при живой сессии не запускался');

    sessions.live.clear();
    assert.deepEqual(await t.git.switch(r.dir, 'feature'), {});
    assert.equal(await t.git.branch(r.dir), 'feature');
    t.clean();
  });

  it('сессия в другом репозитории проекта ветку не держит', async () => {
    using a = repo({ branches: ['feature'] });
    using b = repo({ branches: ['feature'] });
    const sessions = fakeSessions('1.2');
    await using t = await rig({ repos: [a.dir, b.dir], sessions });
    sessions.live.add(b.dir);
    assert.deepEqual(await t.git.switch(a.dir, 'feature'), {});
    assert.match((await t.git.switch(b.dir, 'feature')).error ?? '', /работает сессия/);
  });

  it('сессий в приложении нет совсем - ветка меняется; поставщик 1.1 без uses ответить не может - отказ с причиной', async () => {
    using r = repo({ branches: ['feature'] });
    await using none = await rig({ repos: [r.dir] });
    assert.deepEqual(await none.git.switch(r.dir, 'feature'), {});
    assert.deepEqual(await none.git.switch(r.dir, 'main'), {});

    const legacy = fakeSessions('1.1');
    await using old = await rig({ repos: [r.dir], sessions: legacy });
    const result = await old.git.switch(r.dir, 'feature');
    assert.match(result.error ?? '', /cyborg\.sessions без uses/);
    assert.equal(await old.git.branch(r.dir), 'main');
  });

  it('ветки читаются и меняются только у репозиториев сохранённых проектов (чужой каталог - исключение, ai-cyborg: «Некорректные аргументы»)', async () => {
    using inProject = repo({ branches: ['feature'] });
    using stranger = repo({ branches: ['feature'] });
    // stranger лежит в области workspace (git может читать), но в проекте его нет: так выглядит рабочий каталог живой сессии или worktree.
    await using t = await rig({ repos: [inProject.dir], extraRoots: [stranger.dir] });
    await assert.rejects(t.git.branches(stranger.dir), /Некорректные аргументы git\.branches/);
    await assert.rejects(t.git.switch(stranger.dir, 'feature'), /Некорректные аргументы git\.switch/);
    await assert.rejects(t.git.switch(inProject.dir, 5 as unknown as string), /Некорректные аргументы git\.switch/);
    assert.equal((await t.git.branches(inProject.dir)).current, 'main');
  });

  it('проектов нет совсем (поставщика cyborg.projects нет) - ветки и смена отказывают, остальные члены работают', async () => {
    using r = repo({ branches: ['feature'] });
    await using t = await rig({ repos: [r.dir], noProjects: true });
    assert.equal(await t.git.branch(r.dir), 'main');
    assert.equal((await t.git.status(r.dir))?.branch, 'main');
    await assert.rejects(t.git.branches(r.dir), /Некорректные аргументы git\.branches/);
    await assert.rejects(t.git.switch(r.dir, 'feature'), /Некорректные аргументы git\.switch/);
    assert.equal(await t.git.branch(r.dir), 'main');
  });
});
