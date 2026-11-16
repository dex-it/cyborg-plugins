// Перенос git.test.ts ai-cyborg (запросы git не исполняют core.fsmonitor из конфига репозитория) с теми же утверждениями
// и проверки запросов `root`, `branch`, `status`, `remotes`, `files` на настоящем git через границу плагинов.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { GitStatus } from '@cyborg-harness/contracts';
import { letters, repo, rig } from './kit.ts';

const summary = (status: GitStatus | null): string[] => (status?.changes ?? []).map((c) => `${c.index}${c.worktree} ${c.path}`).toSorted();

describe('git: команда из конфига репозитория не исполняется', () => {
  it('git-запросы не выполняют core.fsmonitor из конфига репозитория; root, branch и status отвечают', async () => {
    using r = repo({ files: { 'tracked.txt': 'a\n' } });
    await using t = await rig({ repos: [r.dir] });
    const marker = path.join(t.box.root, 'fsmonitor-ran');
    const hook = path.join(t.box.root, 'fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    r.write('tracked.txt', 'b\n');
    r.write('new.txt', 'n\n');
    r.git('config', 'core.fsmonitor', hook);

    // Контроль: без защиты этот же git status запускает команду - иначе проверка ниже ничего бы не доказывала.
    execFileSync('git', ['status', '--porcelain'], { cwd: r.dir, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    const controlRan = existsSync(marker);
    rmSync(marker, { force: true });

    const root = await t.git.root(r.dir);
    const branch = await t.git.branch(r.dir);
    const status = await t.git.status(r.dir);
    const files = await t.git.files(r.dir);
    const marks = await t.tree.marks(r.dir);
    await t.git.remotes(r.dir);
    await t.git.headContent(path.join(r.dir, 'tracked.txt'));

    assert.ok(controlRan, 'контроль: этот git запускает core.fsmonitor без защиты');
    assert.equal(existsSync(marker), false, 'команда core.fsmonitor выполнена');
    assert.equal(root, r.dir);
    assert.equal(branch, 'main');
    assert.ok(status);
    assert.deepEqual(letters(status), { 'tracked.txt': 'M', 'new.txt': '?' });
    assert.deepEqual(files?.toSorted(), ['new.txt', 'tracked.txt']);
    assert.deepEqual(marks.toSorted((a, b) => a.path.localeCompare(b.path)), [
      { path: 'new.txt', kind: 'untracked' },
      { path: 'tracked.txt', kind: 'modified' },
    ]);
    t.clean();
    // Каждый запуск начат с закреплённого начала: без хуков и fsmonitor.
    for (const run of t.runs()) assert.ok(run.startsWith('--no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null '), run);
  });

  it('core.hooksPath из конфига репозитория не запускает хук (git switch не отдаёт его); хуки репозитория отключены в каждом запуске', async () => {
    using r = repo({ branches: ['feature'] });
    await using t = await rig({ repos: [r.dir] });
    const marker = path.join(t.box.root, 'hook-ran');
    r.write('.git/hooks/post-checkout', `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(path.join(r.dir, '.git', 'hooks', 'post-checkout'), 0o755);
    assert.deepEqual(await t.git.switch(r.dir, 'feature'), {});
    assert.equal(existsSync(marker), false, 'хук post-checkout выполнен');
    assert.equal(await t.git.branch(r.dir), 'feature');
  });
});

describe('git: status через границу плагинов', () => {
  it('ветка, отслеживаемая и расхождение, изменения по двум буквам, не репозиторий - null', async () => {
    using origin = repo({ files: { 'a.txt': 'a\n' } });
    using work = repo({ files: { 'a.txt': 'a\n', 'src/b.ts': 'b\n' } });
    await using t = await rig({ repos: [work.dir, origin.dir] });
    const clean = await t.git.status(work.dir);
    assert.deepEqual(clean, { branch: 'main', ahead: 0, behind: 0, changes: [] });

    work.write('a.txt', 'x\n');
    work.write('src/new.ts', 'n\n');
    work.git('rm', '-q', 'src/b.ts');
    assert.deepEqual(summary(await t.git.status(work.dir)), ['?? src/new.ts', 'D  src/b.ts', ' M a.txt'].toSorted());
    // `--untracked-files=all`: файлы неотслеживаемого каталога названы по одному, как в ai-cyborg.
    work.write('dir/one.txt', '1');
    work.write('dir/two.txt', '2');
    assert.deepEqual(summary(await t.git.status(work.dir)).filter((s) => s.includes('dir/')), ['?? dir/one.txt', '?? dir/two.txt']);

    work.git('remote', 'add', 'origin', origin.dir);
    work.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    work.git('branch', '-q', '--set-upstream-to=origin/main', 'main');
    work.git('reset', '-q');
    work.git('commit', '-q', '--allow-empty', '-m', 'ahead');
    const tracking = await t.git.status(work.dir);
    assert.equal(tracking?.upstream, 'origin/main');
    assert.equal(tracking?.ahead, 1);
    assert.equal(tracking?.behind, 0);

    assert.equal(await t.git.status(t.plain), null, 'не репозиторий - null, а не ошибка');
  });

  it('вне репозитория: status, root, branch и files - null, remotes - пусто (ai-cyborg отвечал пустым статусом)', async () => {
    await using t = await rig();
    assert.equal(await t.git.status(t.plain), null);
    assert.equal(await t.git.root(t.plain), null);
    assert.equal(await t.git.branch(t.plain), null);
    assert.equal(await t.git.files(t.plain), null);
    assert.deepEqual(await t.git.remotes(t.plain), []);
    assert.deepEqual(await t.tree.marks(t.plain), []);
    assert.deepEqual(await t.git.branches(t.plain), { current: null, local: [], remote: [] });
  });

  it('remotes: адреса fetch-remote, у частичного клона пометка [blob:none] не мешает', async () => {
    using r = repo({ remote: 'https://example.com/a/b.git' });
    await using t = await rig({ repos: [r.dir] });
    assert.deepEqual(await t.git.remotes(r.dir), ['https://example.com/a/b.git']);
    r.git('remote', 'add', 'second', 'git@example.com:a/b.git');
    assert.deepEqual((await t.git.remotes(r.dir)).toSorted(), ['git@example.com:a/b.git', 'https://example.com/a/b.git']);
  });

  it('files: отслеживаемые и неотслеживаемые без игнорируемых .gitignore', async () => {
    using r = repo({ files: { 'a.txt': 'a', '.gitignore': 'ignored.txt\nbuild/\n' } });
    await using t = await rig({ repos: [r.dir] });
    r.write('ignored.txt', 'i');
    r.write('build/out.js', 'o');
    r.write('src/new.ts', 'n');
    assert.deepEqual((await t.git.files(r.dir))?.toSorted(), ['.gitignore', 'a.txt', 'src/new.ts']);
  });
});
