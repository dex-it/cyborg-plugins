// События и «История» удалённого агента на подставных ssh и службе: что `watch` читает на хосте, как переводит и что делает при подхвате.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentEvent } from '@cyborg-harness/contracts';
import { makeAgent, type AgentDeps } from '../agent.ts';
import { translate, waitingReason, wholeLines } from '../events.ts';
import type { Host } from '../host.ts';
import type { RemoteService } from '../service.ts';
import type { Ssh, SshResult } from '../ssh.ts';

const SID = '11111111-1111-1111-1111-111111111111';
const line = (record: object): string => `${JSON.stringify(record)}\n`;
const until = async (what: string, cond: () => boolean): Promise<void> => {
  const end = Date.now() + 3000;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** Файл событий на «хосте»: ssh отвечает на `wc -c < файл` и `tail -c +N файл`. */
function fakeFile(): { ssh: Ssh; append(text: string): void; calls: string[]; fail: { on: boolean } } {
  let content = '';
  const calls: string[] = [];
  const fail = { on: false };
  const ssh = {
    exec: async (_alias: string, cmd: string): Promise<SshResult> => {
      calls.push(cmd);
      if (fail.on) return { code: 255, stdout: '', stderr: 'Connection timed out' };
      const wc = /^wc -c < (\S+)$/.exec(cmd);
      if (wc) return { code: 0, stdout: `${String(new TextEncoder().encode(content).length)}\n`, stderr: '' };
      const tail = /^tail -c \+(\d+) (\S+)$/.exec(cmd);
      if (tail) return { code: 0, stdout: new TextDecoder().decode(new TextEncoder().encode(content).slice(Number(tail[1]) - 1)), stderr: '' };
      return { code: 1, stdout: '', stderr: 'неизвестная команда' };
    },
  } as unknown as Ssh;
  return { ssh, append: (t) => void (content += t), calls, fail };
}

function agentWith(ssh: Ssh, extra: Partial<AgentDeps> = {}) {
  const host = {
    host: 'dev1',
    ensure: () => Promise.resolve(),
    request: async () => ({ type: 'list', sessions: [{ sid: SID, dirs: ['/r/a'], cwd: '/h/a' }] }),
  } as unknown as Host;
  return makeAgent({
    ssh,
    service: { wakeSession: () => Promise.resolve(), historyOf: () => Promise.resolve({ entries: [], unreachable: [] }) } as unknown as RemoteService,
    host: () => host,
    bundle: () => ({ version: 'v1', files: [] }),
    instance: 'i-1',
    allowedHost: async (h) => h === 'dev1',
    projectOf: async () => undefined,
    sshVersion: async () => 'OpenSSH_9.6p1, OpenSSL 3.0',
    env: async () => ({}),
    pollMs: 10,
    ...extra,
  });
}

describe('watch: события хуков claude на хосте читаются опросом файла сессии', () => {
  it('новая (разбуженная) сессия читается с начала, подхваченная живая - с конца: прошлое уже показано', async () => {
    const f = fakeFile();
    f.append(line({ hook_event_name: 'SessionStart', session_id: 'c-1', cwd: '/h/a' }));
    const live = agentWith(f.ssh);
    await live.launch({ sessionId: 'tab', cwd: '/l', resumeId: `${SID}@dev1` });
    const heard: AgentEvent[] = [];
    const sub = live.watch('tab', (e) => heard.push(e));
    await until('первый опрос', () => f.calls.some((c) => c.startsWith('tail')));
    assert.deepEqual(heard, [], 'прошлое подхваченной сессии не повторяется');
    f.append(line({ hook_event_name: 'UserPromptSubmit' }));
    await until('prompt', () => heard.length === 1);
    assert.deepEqual(heard[0], { type: 'prompt' });
    sub.dispose();
  });

  it('перевод: смена cwd, session с resumeId <id>@хост, activity с инструментом, ожидание по белому списку; полуписаная строка ждёт перевода строки', async () => {
    const f = fakeFile();
    const woken = agentWith(f.ssh, {
      service: { wakeSession: () => Promise.resolve({}), historyOf: () => Promise.resolve({ entries: [], unreachable: [] }) } as unknown as RemoteService,
      host: () =>
        ({ host: 'dev1', ensure: () => Promise.resolve(), request: async () => ({ type: 'list', sessions: [{ sid: SID, asleep: true, dirs: ['/r/a'], cwd: '/h/a' }] }) }) as unknown as Host,
    });
    await woken.launch({ sessionId: 'tab', cwd: '/l', resumeId: `${SID}@dev1` });
    f.append(line({ hook_event_name: 'SessionStart', session_id: 'c-1', cwd: '/h/a' }));
    f.append(line({ hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd: '/h/a/.claude/worktrees/x' }));
    f.append('{"hook_event_name":"Notification","notification_type":"permission_prompt"');
    const heard: AgentEvent[] = [];
    const sub = woken.watch('tab', (e) => heard.push(e));
    await until('события', () => heard.length >= 4);
    assert.deepEqual(heard, [
      { type: 'cwd', cwd: '/h/a' },
      { type: 'session', resumeId: 'c-1@dev1' },
      { type: 'cwd', cwd: '/h/a/.claude/worktrees/x' },
      { type: 'activity', tool: 'Edit' },
    ]);
    f.append('}\n');
    await until('ожидание', () => heard.length === 5);
    assert.deepEqual(heard[4], { type: 'waiting', reason: 'Просит разрешение' });
    sub.dispose();
  });

  it('сбой связи не роняет подписку: опрос продолжается, события не теряются и не повторяются', async () => {
    const f = fakeFile();
    const a = agentWith(f.ssh, { host: () => ({ host: 'dev1', ensure: () => Promise.resolve(), request: async () => ({ type: 'list', sessions: [{ sid: SID, asleep: true, dirs: [], cwd: '/h' }] }) }) as unknown as Host });
    await a.launch({ sessionId: 'tab', cwd: '/l', resumeId: `${SID}@dev1` });
    const heard: AgentEvent[] = [];
    const sub = a.watch('tab', (e) => heard.push(e));
    f.append(line({ hook_event_name: 'UserPromptSubmit' }));
    await until('prompt', () => heard.length === 1);
    f.fail.on = true;
    f.append(line({ hook_event_name: 'UserPromptSubmit' }));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(heard.length, 1, 'пока связи нет, событий нет');
    f.fail.on = false;
    await until('второй prompt после возвращения связи', () => heard.length === 2);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(heard.length, 2);
    sub.dispose();
    const calls = f.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(f.calls.length, calls, 'после dispose опроса нет');
  });

  it('без launch подписка молчит и ничего не опрашивает; ended убирает сессию', async () => {
    const f = fakeFile();
    const a = agentWith(f.ssh);
    a.watch('нет-такой', () => assert.fail('событие'));
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(f.calls, []);
    await a.launch({ sessionId: 'tab', cwd: '/l', resumeId: `${SID}@dev1` });
    assert.equal(await a.ended('tab', { code: 0 }), null);
    assert.equal(await a.ended('tab', { code: 255 }), null, 'обрыв ssh - не сбой агента: сессия на хосте жива, подхват - новый launch');
    assert.equal((await a.ended('tab', { code: 127 }))?.kind, 'notFound');
    const sub = a.watch('tab', () => assert.fail('событие'));
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(f.calls, [], 'после ended подписки на неё нет');
    sub.dispose();
  });
});

describe('launch спящей сессии', () => {
  it('сначала будит её службой (wake с её клонами), затем описывает терминал; живую не будит', async () => {
    const f = fakeFile();
    const woke: { sid: string; dirs: string[]; cwd: string }[] = [];
    const service = { wakeSession: (_h: unknown, sid: string, dirs: string[], cwd: string) => (woke.push({ sid, dirs, cwd }), Promise.resolve({})), historyOf: () => Promise.resolve({ entries: [], unreachable: [] }) } as unknown as RemoteService;
    const sleeping = { host: 'dev1', ensure: () => Promise.resolve(), request: async () => ({ type: 'list', sessions: [{ sid: SID, asleep: true, dirs: ['/r/a', '/r/b'], cwd: '/h/a' }] }) } as unknown as Host;
    const spec = await agentWith(f.ssh, { service, host: () => sleeping }).launch({ sessionId: 'tab', cwd: '/l', resumeId: `${SID}@dev1` });
    assert.deepEqual(woke, [{ sid: SID, dirs: ['/r/a', '/r/b'], cwd: '/h/a' }]);
    assert.equal(spec.program, 'ssh');
    const live = [] as unknown[];
    const liveService = { wakeSession: () => (live.push(1), Promise.resolve({})), historyOf: () => Promise.resolve({ entries: [], unreachable: [] }) } as unknown as RemoteService;
    await agentWith(f.ssh, { service: liveService }).launch({ sessionId: 'tab2', cwd: '/l', resumeId: `${SID}@dev1` });
    assert.deepEqual(live, [], 'работающая сессия не будится');
  });
});

describe('facts и history', () => {
  it('facts: ssh найден - версия из OpenSSH_x.y; не найден - found: false; возможности: resume, history, events', async () => {
    const f = fakeFile();
    assert.deepEqual(await agentWith(f.ssh).facts(), { id: 'claude-code-ssh', title: 'Claude Code на SSH-хосте', found: true, version: '9.6', capabilities: { resume: true, history: true, events: true } });
    const missing = await agentWith(f.ssh, { sshVersion: async () => undefined }).facts();
    assert.equal(missing.found, false);
    assert.equal('version' in missing, false);
  });

  it('history: каталог вне проектов или проект без хостов - пусто, иначе записи службы без поля host', async () => {
    const f = fakeFile();
    assert.deepEqual(await agentWith(f.ssh).history('/нет'), []);
    assert.deepEqual(await agentWith(f.ssh, { projectOf: async () => ({ repos: ['/r/a'], hosts: [] }) }).history('/r/a'), []);
    const entries = [{ id: `${SID}@dev1`, cwd: '/r/a', title: 'т', updated: 7, host: 'dev1' }];
    const a = agentWith(f.ssh, {
      projectOf: async () => ({ repos: ['/r/a'], hosts: ['dev1'] }),
      service: { historyOf: () => Promise.resolve({ entries, unreachable: [] }) } as unknown as RemoteService,
    });
    assert.deepEqual(await a.history('/r/a'), [{ id: `${SID}@dev1`, cwd: '/r/a', title: 'т', updated: 7 }]);
  });
});

describe('перевод хуков (копия agent-claude-code)', () => {
  it('waitingReason и translate: те же правила, что у локального агента', () => {
    assert.equal(waitingReason({ hook_event_name: 'Stop' }), 'Ход завершён, ждёт ответа');
    assert.equal(waitingReason({ hook_event_name: 'Stop', background_tasks: [{}] }), null);
    assert.equal(waitingReason({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), null);
    const id = (s: string): string => `${s}@h`;
    assert.deepEqual(translate({ hook_event_name: 'SessionStart', session_id: '--resume' }, undefined, id), []);
    assert.deepEqual(translate({ hook_event_name: 'Stop', last_assistant_message: 'готово' }, undefined, id), [{ type: 'turnEnd', background: false, text: 'готово' }]);
    assert.deepEqual(translate({ hook_event_name: 'PostToolUse', tool_name: 'Edit', agent_id: 'sub' }, undefined, id), []);
  });

  it('wholeLines: только полные строки и их размер в байтах (кириллица - два байта)', () => {
    assert.deepEqual(wholeLines('{"a":"я"}\n{"b"'), { lines: ['{"a":"я"}'], bytes: new TextEncoder().encode('{"a":"я"}\n').length });
    assert.deepEqual(wholeLines('без перевода'), { lines: [], bytes: 0 });
    assert.deepEqual(wholeLines('a\n\n  \nb\n').lines, ['a', 'b']);
  });
});
