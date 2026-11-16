// Фикстуры вместе с настоящим ядром: плагин запускает подставные программы через шлюз `ctx.os.process`, как это будут делать
// настоящие плагины (trackers, sessions, remote-sessions). Ядро передаёт процессу только PATH, HOME и локаль, поэтому настройки
// подставных программ идут через fake.env рядом со скриптами. Нужен `npm run harness:link`; без него тесты пропускаются.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixtureRepo, toolbox } from '@cyborg-plugins/fixtures';
import type { Toolbox } from '@cyborg-plugins/fixtures';

const SPEC = '@cyborg-harness/testing';
interface Kernel extends AsyncDisposable {
  run(command: string, ...args: unknown[]): Promise<unknown>;
  waitForJournal(match: { kind: string; pluginId?: string }): Promise<unknown>;
}
type Kit = { startKernel: (options: Record<string, unknown>) => Promise<Kernel> };
const kit = await import(SPEC).then((m: Kit) => m).catch(() => undefined);
const skip = kit === undefined && 'нет @cyborg-harness/testing: npm run harness:link';

interface Out {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Плагин-«прокладка»: одна команда запускает программу из правил манифеста.
const plugin = {
  manifest: {
    id: 'tools',
    version: '1.0.0',
    engines: { cyborg: '^1' },
    commands: { 'tools.run': { args: ['string', 'strings', 'string?'] } },
    permissions: {
      process: [{ program: 'gh', args: ['api'], deny: ['-X', '--method'] }, 'glab', 'jira', 'claude', 'ssh', 'git'],
    },
  },
  module: {
    activate: (ctx: { commands: { register(name: string, fn: (...a: string[]) => unknown): void }; os: { process: { run(p: string, a: string[], o?: { input?: string }): Promise<Out> } } }) => {
      ctx.commands.register('tools.run', async (...args: unknown[]) => {
        const [program, list, input] = args as [string, string[], string | undefined];
        const r = await ctx.os.process.run(program, list, input === undefined ? {} : { input });
        return { code: r.code, stdout: r.stdout, stderr: r.stderr } satisfies Out;
      });
    },
  },
};

const start = (box: Toolbox): Promise<Kernel> => {
  if (!kit) throw new Error('тест-кит не подключён');
  // В среде ядра только PATH и HOME: ровно то, что получит плагин.
  return kit.startKernel({ plugins: [plugin], os: { env: { PATH: box.env.PATH ?? '', HOME: box.root } } });
};
// Необязательный последний аргумент команды опускается, а не передаётся как undefined: схема аргументов проверяется строго.
const call = async (kernel: Kernel, program: string, args: string[], input?: string): Promise<Out> => (await kernel.run('tools.run', ...(input === undefined ? [program, args] : [program, args, input]))) as Out;

describe('фикстуры через шлюз ядра', { skip }, () => {
  it('gh: вход есть, 30 задач, вызов попал в журнал набора', async () => {
    using box = toolbox();
    await using kernel = await start(box);
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'tools' });
    const r = await call(kernel, 'gh', ['api', '--hostname', 'github.com', '--paginate', 'repos/acme/demo/issues?state=open']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim().split('\n').length, 30);
    assert.match(box.log('gh')[0] ?? '', /repos\/acme\/demo\/issues/);
  });

  it('настройки набора (число задач, вход glab) доходят до программы без переменных окружения', async () => {
    using box = toolbox({ gh: { items: 2 }, glab: { items: 5, host: 'git.corp' } });
    await using kernel = await start(box);
    const gh = await call(kernel, 'gh', ['api', 'repos/a/b/issues?x=1']);
    assert.equal(gh.stdout.trim().split('\n').length, 2);
    const status = await call(kernel, 'glab', ['auth', 'status']);
    assert.match(status.stderr, /^git\.corp\n {2}✓ Logged in to git\.corp as fake-user/);
    const mrs = JSON.parse((await call(kernel, 'glab', ['api', '--hostname', 'git.corp', 'projects/a%2Fb/merge_requests?state=opened&per_page=100'])).stdout) as unknown[];
    assert.equal(mrs.length, 5);
  });

  it('gh без входа: ошибка приходит как данные (код 1), а не как падение плагина', async () => {
    using box = toolbox({ gh: false });
    await using kernel = await start(box);
    const r = await call(kernel, 'gh', ['api', 'user']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not logged in/);
  });

  it('jira и claude: версия, список, подкоманда plugin с журналом', async () => {
    using box = toolbox();
    await using kernel = await start(box);
    assert.equal((await call(kernel, 'jira', ['me'])).stdout.trim(), 'smoke@example.com');
    assert.match((await call(kernel, 'claude', ['--version'])).stdout, /^2\.1\.314/);
    const installed = JSON.parse((await call(kernel, 'claude', ['plugin', 'install', 'smk-plugin'])).stdout) as { outcome: string };
    assert.equal(installed.outcome, 'ok');
    assert.deepEqual(box.log('claudePlugin'), ['plugin install smk-plugin']);
  });

  it('сессия claude через process.run: события хуков пишутся в файл набора', async () => {
    using box = toolbox();
    await using kernel = await start(box);
    const r = await call(kernel, 'claude', ['--settings', 's.json'], 'привет\nask\nperm\n');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /got: \[привет\]/);
    assert.deepEqual(box.eventList().map((e) => e.hook_event_name), ['SessionStart', 'UserPromptSubmit', 'Notification']);
  });

  it('ssh: установка «демона» скриптом из stdin на подставном хосте, как у remote-sessions', async () => {
    using box = toolbox();
    await using kernel = await start(box);
    const script = 'set -e\nmkdir -p "$HOME/.cyborg/agentd"\necho v1 > "$HOME/.cyborg/agentd/version"\necho installed';
    const r = await call(kernel, 'ssh', ['-T', '-o', 'BatchMode=yes', '--', 'work-host', 'sh -s'], script);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'installed');
    const again = await call(kernel, 'ssh', ['--', 'work-host', 'cat "$HOME/.cyborg/agentd/version"']);
    assert.equal(again.stdout.trim(), 'v1');
  });

  it('отказ хоста приходит кодом 255 и текстом ssh', async () => {
    using box = toolbox({ sshFail: 'bad-host' });
    await using kernel = await start(box);
    const r = await call(kernel, 'ssh', ['--', 'bad-host', 'echo hi']);
    assert.equal(r.code, 255);
    assert.match(r.stderr, /Permission denied/);
  });

  it('медленный git: show-toplevel ждёт, остальное нет; репозиторий настоящий', async () => {
    using repo = fixtureRepo();
    using box = toolbox({ slowGit: 0.3 });
    await using kernel = await start(box);
    const t0 = Date.now();
    const status = await call(kernel, 'git', ['-C', repo.dir, 'status', '--short']);
    assert.equal(status.code, 0, status.stderr);
    assert.ok(Date.now() - t0 < 280, 'status идёт без задержки');
    const t1 = Date.now();
    const top = await call(kernel, 'git', ['-C', repo.dir, 'rev-parse', '--show-toplevel']);
    assert.equal(top.code, 0, top.stderr);
    assert.ok(Date.now() - t1 >= 290, 'rev-parse --show-toplevel ждёт задержку и через шлюз');
  });

  it('программа вне правил манифеста и флаг из deny отклоняются ядром: PermissionDenied, а не запуск', async () => {
    using box = toolbox();
    await using kernel = await start(box);
    const denied = (e: unknown): boolean => /PermissionDenied/.test(`${String((e as { code?: unknown }).code)} ${String((e as { name?: unknown }).name)} ${String((e as Error).message)}`);
    await assert.rejects(call(kernel, 'curl', ['http://example.com']), denied);
    await assert.rejects(call(kernel, 'gh', ['api', '-X', 'POST', 'repos/a/b/issues']), denied);
    await assert.rejects(call(kernel, 'gh', ['api', '--method=DELETE', 'repos/a/b/issues/1']), denied);
    assert.deepEqual(box.log('gh'), [], 'отклонённые вызовы до gh не дошли');
    const ok = await call(kernel, 'gh', ['api', 'user']);
    assert.equal(ok.code, 0);
    assert.equal(box.log('gh').length, 1);
  });
});
