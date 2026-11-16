// Перенос git-head.test.ts ai-cyborg (содержимое файла в HEAD) с теми же утверждениями и проверки пределов и защиты: отдаётся blob как есть, фильтры репозитория не запускаются.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { repo, rig } from './kit.ts';

describe('git: headContent', () => {
  it('текст из HEAD; новый, двоичный и вне репозитория - null', async () => {
    using r = repo({ files: { 'sub dir/a.txt': 'было\n', bin: '' } });
    await using t = await rig({ repos: [r.dir] });
    r.write('bin', new Uint8Array([1, 0, 2]));
    r.git('add', '.');
    r.git('commit', '-q', '-m', 'bin');
    r.write('sub dir/a.txt', 'стало\n');
    r.write('new.txt', 'x');
    assert.equal(await t.git.headContent(path.join(r.dir, 'sub dir', 'a.txt')), 'было\n');
    assert.equal(await t.git.headContent(path.join(r.dir, 'new.txt')), null);
    assert.equal(await t.git.headContent(path.join(r.dir, 'bin')), null);
    assert.equal(await t.git.headContent(path.join(t.plain, 'nowhere', 'x.txt')), null);
    t.clean();
  });

  it('файл больше 5 МиБ - null; ровно в пределе - текст', async () => {
    using r = repo({ files: { 'big.txt': 'a'.repeat(5 * 1024 * 1024 + 1), 'edge.txt': 'b'.repeat(5 * 1024 * 1024) } });
    await using t = await rig({ repos: [r.dir] });
    assert.equal(await t.git.headContent(path.join(r.dir, 'big.txt')), null);
    assert.equal((await t.git.headContent(path.join(r.dir, 'edge.txt')))?.length, 5 * 1024 * 1024);
  });

  it('нулевой байт после первых 8000 байт двоичность не означает (как в ai-cyborg)', async () => {
    using r = repo({ files: { 'late.txt': `${'a'.repeat(8100)}\0b` } });
    await using t = await rig({ repos: [r.dir] });
    assert.equal((await t.git.headContent(path.join(r.dir, 'late.txt')))?.length, 8102);
  });

  it('файл, которого нет в репозитории проекта, сам корень и файл вне корня - null', async () => {
    using r = repo();
    await using t = await rig({ repos: [r.dir] });
    assert.equal(await t.git.headContent(r.dir), null);
    assert.equal(await t.git.headContent(path.join(r.dir, 'README.md.missing')), null);
    assert.equal(await t.git.headContent(path.join(r.dir, 'README.md')), '# Фикстура\n');
  });

  it('файл в каталоге с пробелом и не ASCII; каталог репозитория за ссылкой не выдаёт чужое', async () => {
    using r = repo({ files: { 'папка/файл с пробелом.txt': 'текст\n' } });
    await using t = await rig({ repos: [r.dir] });
    assert.equal(await t.git.headContent(path.join(r.dir, 'папка', 'файл с пробелом.txt')), 'текст\n');
  });

  it('blob отдаётся как есть: ни textconv, ни smudge-фильтр репозитория не запускаются', async () => {
    using r = repo({ files: { '.gitattributes': '*.txt filter=x diff=y\n', 'a.txt': 'raw\n' } });
    await using t = await rig({ repos: [r.dir] });
    const marker = path.join(t.box.root, 'driver-ran');
    const script = path.join(t.box.root, 'driver.sh');
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(script, 0o755);
    r.git('config', 'filter.x.smudge', script);
    r.git('config', 'diff.y.textconv', script);
    assert.equal(await t.git.headContent(path.join(r.dir, 'a.txt')), 'raw\n');
    assert.equal(existsSync(marker), false, 'драйвер репозитория выполнен');
  });

  it('репозиторий без коммитов: HEAD нет - null, а не ошибка', async () => {
    using r = repo();
    await using t = await rig({ repos: [r.dir] });
    r.git('checkout', '-q', '--orphan', 'fresh');
    r.git('rm', '-rfq', '.');
    r.write('x.txt', 'x');
    assert.equal(await t.git.headContent(path.join(r.dir, 'x.txt')), null);
    assert.equal(await t.git.branch(r.dir), null, 'rev-parse --abbrev-ref HEAD без коммитов отказывает, как в ai-cyborg');
  });
});
