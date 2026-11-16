// Перенос части test/remote-auth.test.ts ai-cyborg, которая относится к главной части: collectGitAuth, токен Claude, окружение gh и glab.
// Часть про демон (gitAuthEnv, agentAuthEnv, readAuth) перенесена в companions/agentd/test/git-auth.test.ts вместе с кодом демона.
// Изменено: ClaudeTokenStore хранит токен в хранилище секретов ядра, а не в файле под safeStorage Electron.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { memorySecrets, startKernel } from '@cyborg-harness/testing';
import { collectGitAuth, parseRemote, type CliRunner } from '../auth.ts';
import { ClaudeTokenStore, TOKEN_KEY } from '../token.ts';
import { CLAUDE_TOKEN, manifest, PLUGIN_DIR } from './kit.ts';

describe('collectGitAuth', () => {
  const runner = (answers: Record<string, string>, calls: string[]): CliRunner => async (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    const out = answers[line];
    return { code: out === undefined ? 1 : 0, stdout: out ?? '' };
  };

  it('github.com - у gh, прочий хост - у glab, затем у gh как GitHub Enterprise; хост без токена пропущен; каждый хост спрошен один раз', async () => {
    const calls: string[] = [];
    const creds = await collectGitAuth(
      ['git@github.com:o/a.git', 'https://github.com/o/b.git', 'git@gl.example.com:o/c.git', 'git@ghe.example.com:o/d.git', 'git@none.example.com:o/e.git', 'не адрес'],
      runner(
        {
          'gh auth token --hostname github.com': 'gho_A\n',
          'glab config get token --host gl.example.com': 'glpat-B\n',
          'gh auth token --hostname ghe.example.com': 'ghe_C\n',
        },
        calls,
      ),
    );
    assert.deepEqual(creds, [
      { kind: 'github', host: 'github.com', token: 'gho_A' },
      { kind: 'gitlab', host: 'gl.example.com', token: 'glpat-B' },
      { kind: 'github', host: 'ghe.example.com', token: 'ghe_C' },
    ]);
    assert.equal(calls.filter((c) => c.endsWith('--hostname github.com')).length, 1);
  });

  it('корневой токен glab для хоста без записи не уходит хосту, и хост доходит до gh как GitHub Enterprise', async () => {
    const creds = await collectGitAuth(
      ['git@ghe.example.com:o/d.git', 'git@gl.example.com:o/c.git'],
      runner(
        {
          'glab config get token --host ghe.example.com': 'ROOT\n',
          'glab config get token --host gl.example.com': 'glpat-B\n',
          'glab config get token --host cyborg-no-such-host.invalid': 'ROOT\n',
          'gh auth token --hostname ghe.example.com': 'ghe_C\n',
        },
        [],
      ),
    );
    assert.deepEqual(creds, [
      { kind: 'github', host: 'ghe.example.com', token: 'ghe_C' },
      { kind: 'gitlab', host: 'gl.example.com', token: 'glpat-B' },
    ]);
  });

  it('glab спрашивается длинным --host: короткий -h в glab 1.80 и 1.130 - справка с кодом 0', async () => {
    const help = 'Prints the value of a given configuration key.\n\n  USAGE\n    glab config get <key> [--flags]\n';
    const creds = await collectGitAuth(['git@gl.example.com:o/c.git'], runner({ 'glab config get token -h gl.example.com': help, 'glab config get token --host gl.example.com': 'glpat-B\n' }, []));
    assert.deepEqual(creds, [{ kind: 'gitlab', host: 'gl.example.com', token: 'glpat-B' }]);
  });

  it('ответ с пробелом внутри не считается токеном; упавший вызов не роняет сбор', async () => {
    assert.deepEqual(await collectGitAuth(['git@github.com:o/a.git'], runner({ 'gh auth token --hostname github.com': 'not logged in\n' }, [])), []);
    assert.deepEqual(await collectGitAuth(['git@github.com:o/a.git'], () => Promise.reject(new Error('нет gh'))), []);
  });

  it('parseRemote: хост и путь из http, ssh, git и scp-формы; чужая схема, «..» и мусор - null', () => {
    assert.deepEqual(parseRemote('git@GitHub.com:o/a.git'), { host: 'github.com', path: 'o/a' });
    assert.deepEqual(parseRemote('ssh://git@gl.example.com:2222/g/s/p.git'), { host: 'gl.example.com', path: 'g/s/p' });
    assert.deepEqual(parseRemote('https://h.example.com/o/a/'), { host: 'h.example.com', path: 'o/a' });
    for (const url of ['file:///srv/a.git', '/srv/a.git', 'https://h.example.com/o/../a', 'не адрес', 'ftp://h/o/a']) assert.equal(parseRemote(url), null, url);
  });
});

describe('токен Claude', () => {
  it('хранится в хранилище секретов ядра; статус, замена и стирание', async () => {
    const secrets = memorySecrets();
    const store = new ClaudeTokenStore(secrets);
    assert.deepEqual(await store.status(), { set: false, stored: null });
    assert.deepEqual(await store.set(`  ${CLAUDE_TOKEN}\n`), { set: true, stored: 'secrets' });
    assert.equal(secrets.map.get(TOKEN_KEY), CLAUDE_TOKEN);
    assert.equal(await new ClaudeTokenStore(secrets).get(), CLAUDE_TOKEN, 'новый экземпляр читает из хранилища');
    assert.deepEqual(await store.clear(), { set: false, stored: null });
    assert.equal(secrets.map.has(TOKEN_KEY), false);
  });

  it('неверный токен - отказ без изменений; хранилища нет - токена нет, а не падение', async () => {
    const secrets = memorySecrets();
    const store = new ClaudeTokenStore(secrets);
    await store.set(CLAUDE_TOKEN);
    await assert.rejects(store.set('короткий'), /claude setup-token/);
    await assert.rejects(store.set(`${CLAUDE_TOKEN} ${CLAUDE_TOKEN}`), /claude setup-token/);
    assert.equal(await store.get(), CLAUDE_TOKEN);
    const broken = new ClaudeTokenStore({ get: () => Promise.reject(new Error('Unavailable')), set: () => Promise.reject(new Error('Unavailable')), delete: () => Promise.resolve() });
    assert.equal(await broken.get(), null);
  });

  it('команды плагина: токен уходит в секреты ядра и нигде больше - ни в config, ни в state, ни в журнал', async () => {
    const { memoryStore } = await import('@cyborg-harness/testing');
    const config = memoryStore();
    const state = memoryStore();
    await using kernel = await startKernel({ plugins: [PLUGIN_DIR], config: config.store, state: state.store });
    assert.deepEqual(await kernel.run('remote-sessions.claude-token.status'), { set: false, stored: null });
    assert.deepEqual(await kernel.run('remote-sessions.claude-token.set', CLAUDE_TOKEN), { set: true, stored: 'secrets' });
    assert.deepEqual(await kernel.run('remote-sessions.claude-token.status'), { set: true, stored: 'secrets' });
    const secret = [...kernel.secrets.map.entries()].find(([, v]) => v === CLAUDE_TOKEN);
    assert.ok(secret, 'токен в хранилище секретов ядра');
    const where = JSON.stringify([[...config.docs.entries()], [...state.docs.entries()], kernel.journal]);
    assert.equal(where.includes(CLAUDE_TOKEN), false, 'токен в config, state или журнале');
    await assert.rejects(kernel.run('remote-sessions.claude-token.set', 'плохой токен'), /claude setup-token/);
    assert.deepEqual(await kernel.run('remote-sessions.claude-token.clear'), { set: false, stored: null });
    assert.equal(kernel.secrets.map.size, 0);
  });
});

describe('окружение gh и glab', () => {
  it('правила process для gh и glab не называют переменных окружения: токены, не привязанные к хосту, до них не доходят', () => {
    for (const program of ['gh', 'glab']) {
      const rules = manifest.permissions.process.filter((r) => r.program === program);
      assert.equal(rules.length, 1, program);
      assert.equal(rules[0]?.env, undefined, `${program}: env`);
    }
    // Единственная переменная, которую плагин вообще передаёт программам, - сокет ssh-agent и только ssh.
    const withEnv = manifest.permissions.process.filter((r) => r.env !== undefined);
    assert.deepEqual(withEnv.map((r) => [r.program, r.env]), [['ssh', ['SSH_AUTH_SOCK']]]);
  });
});
