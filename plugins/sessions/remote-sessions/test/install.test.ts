// Установка агента и проверка хоста: скрипты на настоящем sh. Перенос блока «установка агента и проверка хоста» из remote-tools.test.ts ai-cyborg;
// отличия: бандл из двух файлов (agentd.js и client.js) и двух скриптов, `bundleOf` асинхронный (WebCrypto).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { bundleOf, CLIENT_SH, CONNECT_SH, installScript } from '../install.ts';
import { LOGIN_PATH, PREFLIGHT_SCRIPT } from '../preflight.ts';

const sh = (script: string, home: string) => spawnSync('sh', ['-s'], { input: script, env: { ...process.env, HOME: home, SHELL: '/bin/sh' }, encoding: 'utf8' });
const tmpHome = (t: { after: (fn: () => void) => void }): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-inst-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};
const FILES = ['agentd.js', 'client.js', 'client.sh', 'connect.sh'];

describe('установка агента и проверка хоста: скрипты на настоящем sh', () => {
  it('установка кладёт агент, клиент и скрипты в каталог версии с правами 0700 и проверяет контрольную сумму', async (t) => {
    const home = tmpHome(t);
    const bundle = await bundleOf('console.log("agentd");\n', 'console.log("client");\n');
    const done = sh(installScript(bundle), home);
    assert.equal(done.status, 0, done.stderr);
    const dir = path.join(home, '.cyborg', 'agentd', bundle.version);
    assert.equal(fs.readFileSync(path.join(dir, 'agentd.js'), 'utf8'), (bundle.files[0]?.source ?? '') + '\n');
    assert.equal(fs.readFileSync(path.join(dir, 'client.js'), 'utf8'), (bundle.files[1]?.source ?? '') + '\n');
    assert.match(fs.readFileSync(path.join(dir, 'connect.sh'), 'utf8'), /agentd\.js" connect/);
    assert.match(fs.readFileSync(path.join(dir, 'client.sh'), 'utf8'), /client\.js" "\$@"/);
    assert.equal(fs.statSync(path.join(home, '.cyborg')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'connect.sh')).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(dir).sort(), FILES);
  });

  it('версия зависит от обоих файлов и скриптов запуска; хеш файла - sha256 его текста с переводом строки', async () => {
    const a = await bundleOf('a', 'c');
    assert.notEqual(a.version, (await bundleOf('b', 'c')).version);
    assert.notEqual(a.version, (await bundleOf('a', 'd')).version);
    assert.equal(a.version, (await bundleOf('a\n\n', 'c\n')).version, 'хвостовые переводы строк не в счёт');
    assert.match(a.version, /^[0-9a-f]{16}$/);
    const expected = spawnSync('sh', ['-c', "printf 'a\\n' | shasum -a 256 | cut -d' ' -f1"], { encoding: 'utf8' }).stdout.trim();
    assert.equal(a.files[0]?.sha256, expected);
  });

  it('не сошлась сумма - установка падает и версию не создаёт', async (t) => {
    const home = tmpHome(t);
    const bundle = await bundleOf('console.log("agentd");\n', 'console.log("client");\n');
    const bad = { ...bundle, files: bundle.files.map((f, i) => (i === 1 ? { ...f, sha256: '0'.repeat(64) } : f)) };
    const done = sh(installScript(bad), home);
    assert.notEqual(done.status, 0);
    assert.match(done.stderr, /контрольная сумма client\.js/);
    assert.equal(fs.existsSync(path.join(home, '.cyborg', 'agentd', bundle.version)), false);
  });

  it('сорванная установка не оставляет каталога версии: проверка хоста её не видит, повторная установка чинит обломок', async (t) => {
    const home = tmpHome(t);
    const bundle = await bundleOf('console.log("agentd");\n', 'console.log("client");\n');
    const agentd = path.join(home, '.cyborg', 'agentd');
    const bad = { ...bundle, files: bundle.files.map((f) => ({ ...f, sha256: '0'.repeat(64) })) };
    assert.notEqual(sh(installScript(bad), home).status, 0);
    assert.deepEqual(fs.readdirSync(agentd), []);
    assert.match(sh(PREFLIGHT_SCRIPT, home).stdout, /^agentd=$/m);
    fs.mkdirSync(path.join(agentd, bundle.version));
    fs.writeFileSync(path.join(agentd, bundle.version, 'connect.sh'), 'обломок');
    assert.equal(sh(installScript(bundle), home).status, 0);
    assert.deepEqual(fs.readdirSync(path.join(agentd, bundle.version)).sort(), FILES);
    assert.deepEqual(fs.readdirSync(agentd), [bundle.version]);
  });

  it('исходник с разделителем heredoc внутри переносится целым', async (t) => {
    const home = tmpHome(t);
    const bundle = await bundleOf('const x = `\nCYBORG_EOF\n`;\n', 'y');
    assert.equal(sh(installScript(bundle), home).status, 0);
    assert.equal(fs.readFileSync(path.join(home, '.cyborg', 'agentd', bundle.version, 'agentd.js'), 'utf8'), (bundle.files[0]?.source ?? '') + '\n');
  });

  describe('PATH логин-оболочки', () => {
    const pathUnder = (shell: string, home: string) =>
      spawnSync('sh', ['-s'], { input: `${LOGIN_PATH}echo "path=$PATH"\n`, env: { ...process.env, HOME: home, SHELL: shell }, encoding: 'utf8' }).stdout;
    const withProfile = (t: { after: (fn: () => void) => void }): string => {
      const home = tmpHome(t);
      fs.writeFileSync(path.join(home, '.profile'), 'echo "/etc/motd: шум профиля"\nPATH=/opt/prof/bin:$PATH\nexport PATH\n');
      return home;
    };

    it('проверка хоста, установка, connect.sh и client.sh берут PATH одним и тем же способом', async () => {
      assert.ok(PREFLIGHT_SCRIPT.startsWith(LOGIN_PATH));
      assert.ok(CONNECT_SH.includes(LOGIN_PATH));
      assert.ok(CLIENT_SH.includes(LOGIN_PATH));
      assert.ok(installScript(await bundleOf('x', 'y')).includes(LOGIN_PATH));
    });

    for (const shell of ['/bin/bash', '/bin/dash'].filter((s) => fs.existsSync(s))) {
      it(`${path.basename(shell)}: PATH из профиля, строки шума с / перед ним не мешают`, (t) => {
        assert.match(pathUnder(shell, withProfile(t)), /^path=\/opt\/prof\/bin:/m);
      });
    }

    it('оболочка, которая принимает только -l и команды из stdin (как tcsh), печатает шум до PATH', (t) => {
      const home = tmpHome(t);
      const shell = path.join(home, 'tcsh-like');
      fs.writeFileSync(shell, '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = -l ] || exit 1\necho "/etc/motd: привет"\necho "Last login: вчера"\nPATH=/opt/fake/bin:$PATH\nexport PATH\nexec /bin/sh\n', { mode: 0o755 });
      assert.match(pathUnder(shell, home), /^path=\/opt\/fake\/bin:/m);
    });

    it('оболочки нет - остаётся PATH ssh', (t) => {
      assert.match(pathUnder('/nonexistent/shell', tmpHome(t)), new RegExp(`^path=${(process.env.PATH ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    });
  });

  it('проверка хоста печатает home и установленные версии', (t) => {
    const home = tmpHome(t);
    fs.mkdirSync(path.join(home, '.cyborg', 'agentd', 'abc'), { recursive: true });
    const out = sh(PREFLIGHT_SCRIPT, home).stdout;
    assert.match(out, new RegExp(`^home=${home}$`, 'm'));
    assert.match(out, /^agentd=abc $/m);
  });
});
