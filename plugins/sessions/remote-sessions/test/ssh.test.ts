// Транспорт ssh поверх process.run: закреплённые аргументы, проверка алиаса до запуска, сроки и окружение. Манифест называет те же аргументы в правиле process.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProcessOptions, ProcessResult } from '@cyborg-harness/contracts';
import { Host } from '../host.ts';
import { bundleOf } from '../install.ts';
import { RUN_LIMIT_MS, Ssh, SSH_PINNED, SSH_PTY_PINNED } from '../ssh.ts';
import { manifest } from './kit.ts';

interface Call {
  program: string;
  args: readonly string[];
  options: ProcessOptions | undefined;
}

function recorder(answer: Partial<ProcessResult> | (() => Promise<ProcessResult>) = {}): { calls: Call[]; run: (program: string, args: readonly string[], options?: ProcessOptions) => Promise<ProcessResult> } {
  const calls: Call[] = [];
  return {
    calls,
    run: async (program, args, options) => {
      calls.push({ program, args, options });
      if (typeof answer === 'function') return answer();
      return { code: 0, signal: null, stdout: '', stderr: '', truncated: false, ...answer };
    },
  };
}

describe('Ssh: один вызов - одна короткая программа ssh', () => {
  it('аргументы: закреплённые, затем алиас и удалённая команда; скрипт идёт в stdin `sh -s`; срок не больше 30 с', async () => {
    const r = recorder();
    const ssh = new Ssh(r.run);
    await ssh.run('dev1', 'echo привет\n');
    await ssh.exec('dev1', 'sh .cyborg/x', { timeoutMs: 999_999 });
    assert.equal(r.calls[0]?.program, 'ssh');
    assert.deepEqual(r.calls[0]?.args, [...SSH_PINNED, 'dev1', 'sh -s']);
    assert.equal(r.calls[0]?.options?.input, 'echo привет\n');
    assert.equal(r.calls[0]?.options?.timeoutMs, RUN_LIMIT_MS);
    assert.equal(r.calls[1]?.options?.timeoutMs, RUN_LIMIT_MS, 'без limitMs срок не растёт сверх 30 с');
    const long = recorder();
    await new Ssh(long.run).exec('dev1', 'x', { timeoutMs: 120_000, limitMs: 180_000 });
    assert.equal(long.calls[0]?.options?.timeoutMs, 120_000, 'долгая операция просит больше и получает');
  });

  it('алиас с ведущим «-», пробелом или управляющим символом не доходит до ssh: он принял бы его за ключ', async () => {
    const r = recorder();
    const ssh = new Ssh(r.run);
    for (const alias of ['-oProxyCommand=touch /tmp/x', '-F/etc/passwd', 'a b', 'a\nb', '', '‮dev']) {
      const res = await ssh.exec(alias, 'true');
      assert.equal(res.code, 255, JSON.stringify(alias));
      assert.match(res.stderr, /алиас хоста не годится/);
    }
    assert.deepEqual(r.calls, []);
  });

  it('окружение: только то, что отдал env() (SSH_AUTH_SOCK); пусто - поле не передаётся', async () => {
    const withSock = recorder();
    await new Ssh(withSock.run, async () => ({ SSH_AUTH_SOCK: '/tmp/agent.sock' })).exec('dev1', 'true');
    assert.deepEqual(withSock.calls[0]?.options?.env, { SSH_AUTH_SOCK: '/tmp/agent.sock' });
    const none = recorder();
    await new Ssh(none.run).exec('dev1', 'true');
    assert.equal(none.calls[0]?.options && 'env' in none.calls[0].options, false);
  });

  it('остановка по сроку - как зависшее соединение (код 255, «timed out»); сбой запуска ssh - код 255 с причиной', async () => {
    const timedOut = new Ssh(recorder({ code: null, signal: 'SIGTERM', stdout: 'часть' }).run);
    assert.deepEqual(await timedOut.exec('dev1', 'x'), { code: 255, stdout: 'часть', stderr: 'Connection timed out' });
    const missing = new Ssh(() => Promise.reject(new Error('ssh: NotFound')));
    assert.deepEqual(await missing.exec('dev1', 'x'), { code: 255, stdout: '', stderr: 'ssh: NotFound' });
    const failed = await new Ssh(recorder({ code: 255, stderr: 'user@h: Permission denied (publickey).' }).run).exec('dev1', 'x');
    assert.equal(failed.code, 255);
  });
});

describe('манифест и аргументы совпадают', () => {
  it('правило process для ssh называет SSH_PINNED, правило launch - SSH_PTY_PINNED (те же ключи, `-tt` вместо `-T`), оба с SSH_AUTH_SOCK', () => {
    const process = manifest.permissions.process.find((r) => r.program === 'ssh' && r.args.length > 1);
    assert.deepEqual(process?.args, [...SSH_PINNED]);
    assert.deepEqual(process?.env, ['SSH_AUTH_SOCK']);
    const launch = manifest.permissions.launch.find((r) => r.program === 'ssh');
    assert.deepEqual(launch?.args, [...SSH_PTY_PINNED]);
    assert.equal(SSH_PTY_PINNED[0], '-tt');
    assert.deepEqual(SSH_PTY_PINNED.slice(1), SSH_PINNED.slice(1));
  });

  it('ни одно правило не пускает шире: после «--» ключей ssh нет, другие программы - только с закреплёнными подкомандами', () => {
    assert.equal(SSH_PINNED.at(-1), '--');
    for (const rule of manifest.permissions.process) {
      if (rule.program === 'ssh') continue;
      assert.ok(rule.args.length >= 3, `${rule.program}: подкоманда закреплена`);
    }
    assert.deepEqual(manifest.permissions.process.map((r) => r.program), ['ssh', 'ssh', 'git', 'gh', 'glab']);
  });
});

describe('Host: ответы демона по ssh', () => {
  const answerWith = (lines: object[], code = 0) => recorder({ code, stdout: lines.map((l) => JSON.stringify(l)).join('\n') + '\n' });

  it('пачка: hello с экземпляром идёт первым, rid по порядку; ответ error - отказ с текстом демона', async () => {
    const r = answerWith([{ type: 'hello', rid: 1, proto: 2 }, { type: 'list', rid: 2, sessions: [] }]);
    const host = new Host({ host: 'dev1', ssh: new Ssh(r.run), bundle: await bundleOf('a', 'b'), instance: 'i-1' });
    const [list] = await host.rpc([{ type: 'list' }]);
    assert.deepEqual(list, { type: 'list', rid: 2, sessions: [] });
    const input = String(r.calls[0]?.options?.input).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(input, [{ type: 'hello', proto: 2, instance: 'i-1', rid: 1 }, { type: 'list', rid: 2 }]);
    assert.match(String(r.calls[0]?.args.at(-1)), /^sh \.cyborg\/agentd\/[0-9a-f]{16}\/client\.sh rpc$/);
    const bad = answerWith([{ type: 'hello', rid: 1, proto: 2 }, { type: 'error', rid: 2, message: 'сессия на хосте не найдена' }]);
    const h2 = new Host({ host: 'dev1', ssh: new Ssh(bad.run), bundle: await bundleOf('a', 'b'), instance: 'i-1' });
    await assert.rejects(h2.request({ type: 'attach', sid: 'x' }), /сессия на хосте не найдена/);
  });

  it('нет ответа на запрос: причина ssh, если он упал, иначе «не ответил»; шум профиля в stdout не мешает', async () => {
    const down = recorder({ code: 255, stderr: 'ssh: Could not resolve hostname dev1' });
    const h1 = new Host({ host: 'dev1', ssh: new Ssh(down.run), bundle: await bundleOf('a', 'b'), instance: 'i' });
    await assert.rejects(h1.request({ type: 'list' }), /алиас не найден/);
    const silent = recorder({ code: 0, stdout: '' });
    const h2 = new Host({ host: 'dev1', ssh: new Ssh(silent.run), bundle: await bundleOf('a', 'b'), instance: 'i' });
    await assert.rejects(h2.request({ type: 'list' }, 5000), /не ответил за 5 с/);
    const noisy = recorder({ code: 0, stdout: 'Welcome to host\n{"type":"hello","rid":1}\n{"type":"list","rid":2,"sessions":[]}\nbye\n' });
    const h3 = new Host({ host: 'dev1', ssh: new Ssh(noisy.run), bundle: await bundleOf('a', 'b'), instance: 'i' });
    assert.deepEqual((await h3.request({ type: 'list' })).sessions, []);
  });
});

describe('Host.ensure: версия демона и протокол (NFR-17002)', () => {
  const good = 'home=/home/u\nuname=Linux\nnode=v20.1.0\ngit=/usr/bin/git\nclaude=/bin/claude\nscript=/usr/bin/script\nauth={"loggedIn":true}\nagentd=\n';

  /** ssh хоста: preflight и установка проходят, `rpc` отвечает на hello так, как скажет тест. */
  function hostWith(hello: (call: number) => object, shutdowns: string[] = []) {
    let calls = 0;
    const ssh = {
      run: async (_a: string, script: string) => (script.includes('echo "home=$HOME"') ? { code: 0, stdout: good, stderr: '' } : { code: 0, stdout: 'installed\n', stderr: '' }),
      exec: async (_a: string, _c: string, o: { input?: string }) => {
        const sent = String(o.input).trim().split('\n').map((l) => JSON.parse(l) as { type: string; rid: number });
        if (sent.some((m) => m.type === 'shutdown')) shutdowns.push('shutdown');
        const replies = sent.map((m) => (m.type === 'hello' ? { type: 'hello', rid: m.rid, ...hello(++calls) } : { type: m.type, rid: m.rid }));
        return { code: 0, stdout: replies.map((m) => JSON.stringify(m)).join('\n') + '\n', stderr: '' };
      },
    } as unknown as Ssh;
    return bundleOf('a', 'b').then((bundle) => ({ host: new Host({ host: 'dev1', ssh, bundle, instance: 'i', sleep: () => Promise.resolve() }), bundle }));
  }

  it('демон нужной версии - готово; с сессиями и тем же протоколом чужой версии - работаем с ним; несовместимый с сессиями - отказ с числом сессий', async () => {
    let current = '';
    const ready = await hostWith(() => ({ proto: 2, version: current, sessions: 0, disk: { free: 4, total: 8 }, config: 'h1' }));
    current = ready.bundle.version;
    await ready.host.ensure();
    assert.deepEqual(ready.host.disk, { free: 4, total: 8 });
    assert.equal(ready.host.config, 'h1');
    assert.equal(ready.host.home, '/home/u');
    const old = await hostWith(() => ({ proto: 2, version: 'старая', sessions: 3 }));
    await old.host.ensure();
    const incompatible = await hostWith(() => ({ proto: 1, version: 'старая', sessions: 2 }));
    await assert.rejects(incompatible.host.ensure(), /несовместимой версии с 2 сессиями/);
  });

  it('устаревший демон без сессий просят выйти и пробуют снова; не обновился за 4 попытки - отказ', async () => {
    const shutdowns: string[] = [];
    const stuck = await hostWith(() => ({ proto: 2, version: 'старая', sessions: 0 }), shutdowns);
    await assert.rejects(stuck.host.ensure(), /демон на хосте не обновился/);
    assert.equal(shutdowns.length, 4);
    const shutdowns2: string[] = [];
    let version = 'старая';
    const updated = await hostWith(() => ({ proto: 2, version, sessions: 0 }), shutdowns2);
    version = updated.bundle.version;
    await updated.host.ensure();
    assert.deepEqual(shutdowns2, [], 'нужная версия сразу - выходить не просят');
  });
});
