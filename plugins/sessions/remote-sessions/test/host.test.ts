import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ASSETS } from '../assets.generated.ts';
import { bundleOf, installScript } from '../install.ts';
import { bundle, CLAUDE_TOKEN, rig } from './kit.ts';

const DISK = ['p1', 'dev1'];

describe('хост: проверка, установка демона, запросы по ssh на подставном хосте', () => {
  it('первый вызов проверяет хост, ставит демон и client.sh в каталог версии, отвечает disk; повторный не ставит заново', async () => {
    await using r = await rig();
    const v = (await bundle()).version;
    const disk = (await r.call('remote-sessions.disk', ...DISK)) as { host: string; free: number; total: number; sessions: unknown[] };
    assert.equal(disk.host, 'dev1');
    assert.ok(disk.total > 0 && disk.free > 0, 'место на диске хоста');
    assert.deepEqual(disk.sessions, []);
    for (const name of ['agentd.js', 'client.js', 'connect.sh', 'client.sh']) assert.ok(existsSync(r.cyborg('agentd', v, name)), name);
    assert.equal(statSync(r.cyborg('agentd', v, 'connect.sh')).mode & 0o777, 0o700);
    assert.equal(statSync(r.cyborg()).mode & 0o777, 0o700);
    const calls = r.sshLog();
    const installs = calls.filter((c) => c.endsWith('-- dev1 sh -s'));
    assert.equal(installs.length, 2, 'проверка и установка');
    await r.call('remote-sessions.disk', ...DISK);
    assert.equal(r.sshLog().filter((c) => c.endsWith('-- dev1 sh -s')).length, 2, 'свежая проверка хоста не повторяется');
    // Все вызовы - закреплённые аргументы, алиас после «--».
    for (const c of calls) assert.match(c, /^-T -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -- dev1 /);
    assert.equal(readFileSync(r.cyborg('agentd', v, 'agentd.js'), 'utf8').trimEnd(), (await bundle()).files[0]?.source);
  });

  it('хост, отказавший в ключе, называет причину с советом про ssh-agent; другие хосты работают', async () => {
    await using r = await rig({ hosts: ['dev1', 'bad-host'], sshFail: 'bad-host' });
    await assert.rejects(r.call('remote-sessions.disk', 'p1', 'bad-host'), /ssh-agent/);
    assert.ok(r.sshLog().some((c) => c.endsWith('-- bad-host sh -s')));
    assert.equal(((await r.call('remote-sessions.disk', 'p1', 'dev1')) as { host: string }).host, 'dev1');
  });

  it('claude на хосте не залогинен и токена нет - отказ с указанием, что делать; с токеном (секреты ядра) хост проходит', async () => {
    await using r = await rig({ token: false });
    await assert.rejects(r.call('remote-sessions.disk', ...DISK), /не залогинен/);
    assert.equal(existsSync(r.cyborg('agentd')), false, 'демон на негодный хост не ставится');
    await r.call('remote-sessions.claude-token.set', CLAUDE_TOKEN);
    assert.equal(((await r.call('remote-sessions.disk', ...DISK)) as { host: string }).host, 'dev1');
    assert.deepEqual(r.sshLog().filter((c) => c.includes(CLAUDE_TOKEN)), [], 'токен не попадает в аргументы ssh');
  });

  it('хост не из списка проекта и чужой проект отвергаются до ssh', async () => {
    await using r = await rig();
    await assert.rejects(r.call('remote-sessions.disk', 'p1', 'evil'), /хост не из списка проекта/);
    await assert.rejects(r.call('remote-sessions.disk', 'нет', 'dev1'), /проект не найден/);
    await assert.rejects(r.call('remote-sessions.disk', 'p1', '-oProxyCommand=x'), /хост не из списка проекта/);
    assert.deepEqual(r.sshLog(), []);
  });

  it('демон прежней версии без сессий заменяется: shutdown, затем запуск из каталога новой версии', async () => {
    await using r = await rig();
    const current = await bundle();
    const old = await bundleOf((ASSETS['agentd/agentd.js'] ?? '') + '\n// прежняя версия\n', ASSETS['agentd/client.js'] ?? '');
    assert.notEqual(old.version, current.version);
    assert.equal(r.box.run('ssh', ['--', 'dev1', 'sh -s'], { input: installScript(old) }).status, 0);
    const hello = (version: string) => {
      const out = r.box.run('ssh', ['--', 'dev1', `sh .cyborg/agentd/${version}/client.sh rpc`], { input: '{"type":"hello","proto":2,"instance":"x","rid":1}\n' });
      return JSON.parse(out.stdout.trim().split('\n')[0] ?? '{}') as { version?: string };
    };
    assert.equal(hello(old.version).version, old.version, 'на хосте работает прежний демон');
    const oldPid = Number(readFileSync(r.cyborg('run', 'agentd.lock'), 'utf8'));
    await r.call('remote-sessions.disk', ...DISK);
    assert.equal(hello(current.version).version, current.version, 'ответил демон новой версии');
    assert.notEqual(Number(readFileSync(r.cyborg('run', 'agentd.lock'), 'utf8')), oldPid);
    assert.throws(() => process.kill(oldPid, 0), 'прежний демон вышел');
    assert.equal(statSync(r.cyborg('run', 'agentd.sock')).isSocket(), true);
  });
});
