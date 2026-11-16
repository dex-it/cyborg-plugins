// Перенос части test/remote-auth.test.ts ai-cyborg, которая относится к демону (src/agentd/git-auth.ts): те же утверждения.
// Часть про главную часть (collectGitAuth, токен Claude, окружение gh и glab) перенесена в plugins/sessions/remote-sessions/test/auth.test.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { agentAuthEnv, gitAuthEnv, readAuth } from '../src/agentd/git-auth';

const tmp = (t: { after: (fn: () => void) => void }): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** git под чистым HOME: настройки машины разработчика не влияют на исход. */
const git = (home: string, env: Record<string, string>, args: string[], input?: string) =>
  spawnSync('git', args, {
    cwd: home,
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env },
  });

describe('gitAuthEnv на настоящем git', () => {
  const auth = readAuth({ git: [{ kind: 'gitlab', host: 'gl.example.com', token: 'glpat-ONE' }, { kind: 'github', host: 'github.com', token: 'gho_TWO' }], primary: 'gl.example.com' });

  it('git@ и ssh:// хоста идут по https', (t) => {
    const home = tmp(t);
    const env = gitAuthEnv(auth);
    assert.equal(git(home, env, ['ls-remote', '--get-url', 'git@gl.example.com:o/a.git']).stdout.trim(), 'https://gl.example.com/o/a.git');
    assert.equal(git(home, env, ['ls-remote', '--get-url', 'ssh://git@github.com/o/b.git']).stdout.trim(), 'https://github.com/o/b.git');
    assert.equal(git(home, env, ['ls-remote', '--get-url', 'git@other.example.com:o/c.git']).stdout.trim(), 'git@other.example.com:o/c.git', 'хост без токена не переписывается');
  });

  it('помощник учётных данных отдаёт токен своего хоста, а помощник из настроек хоста не спрашивается', (t) => {
    const home = tmp(t);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[credential]\n\thelper = "!f() { echo username=u; echo password=WRONG; }; f"\n');
    const fill = (host: string) => git(home, gitAuthEnv(auth), ['credential', 'fill'], `protocol=https\nhost=${host}\n\n`).stdout;
    assert.match(fill('gl.example.com'), /^username=oauth2$/m);
    assert.match(fill('gl.example.com'), /^password=glpat-ONE$/m);
    assert.match(fill('github.com'), /^username=x-access-token$/m);
    assert.match(fill('github.com'), /^password=gho_TWO$/m);
    assert.match(fill('other.example.com'), /^password=WRONG$/m, 'чужой хост - прежние помощники');
  });

  it('gh получает токен github.com, glab - токен и хост рабочего репозитория; Claude - свой токен', () => {
    const env = agentAuthEnv({ ...auth, claude: 'sk-ant-oat01-XYZ' });
    assert.equal(env.GH_TOKEN, 'gho_TWO');
    assert.equal(env.GITLAB_TOKEN, 'glpat-ONE');
    assert.equal(env.GITLAB_HOST, 'https://gl.example.com');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-XYZ');
    const two = gitAuthEnv(readAuth({ git: [{ kind: 'gitlab', host: 'a.example.com', token: 'A' }, { kind: 'gitlab', host: 'b.example.com', token: 'B' }], primary: 'b.example.com' }));
    assert.equal(two.GITLAB_HOST, 'https://b.example.com');
    assert.equal(two.GITLAB_TOKEN, 'B');
    const ghe = gitAuthEnv(readAuth({ git: [{ kind: 'github', host: 'ghe.example.com', token: 'E' }] }));
    assert.equal(ghe.GH_TOKEN, undefined);
    assert.equal(ghe.GH_ENTERPRISE_TOKEN, 'E');
    assert.equal(ghe.GH_HOST, undefined, 'репозиторий сессии не на этом хосте - gh выбирает хост сам');
    const primary = gitAuthEnv(readAuth({ git: [{ kind: 'github', host: 'a.example.com', token: 'A' }, { kind: 'github', host: 'b.example.com', token: 'B' }], primary: 'b.example.com' }));
    assert.equal(primary.GH_ENTERPRISE_TOKEN, 'B');
    assert.equal(primary.GH_HOST, 'b.example.com');
    assert.deepEqual(gitAuthEnv({ git: [] }), {});
  });
});

describe('readAuth', () => {
  it('отбрасывает токен с переводом строки, чужой вид, хост с путём и повтор хоста', () => {
    const auth = readAuth({
      git: [
        { kind: 'gitlab', host: 'a.example.com', token: 'ok' },
        { kind: 'gitlab', host: 'b.example.com', token: 'x\npassword=evil' },
        { kind: 'bitbucket', host: 'c.example.com', token: 'ok' },
        { kind: 'github', host: 'd.example.com/x', token: 'ok' },
        { kind: 'github', host: 'a.example.com', token: 'second' },
        'мусор',
      ],
      primary: 'a.example.com\n',
      claude: 'с пробелом токен',
    });
    assert.deepEqual(auth, { git: [{ kind: 'gitlab', host: 'a.example.com', token: 'ok' }] });
    assert.deepEqual(readAuth(undefined), { git: [] });
    assert.equal(readAuth({ git: Array.from({ length: 40 }, (_, i) => ({ kind: 'gitlab', host: `h${i}.example.com`, token: 't' })) }).git.length, 16);
  });
});
