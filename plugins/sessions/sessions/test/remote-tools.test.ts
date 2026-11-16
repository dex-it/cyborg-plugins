// Перенос блоков test/remote-tools.test.ts ai-cyborg про инструменты (набор по виду сессии, validateSpawn, validateReport и validateCloseAgent, createSessionTools: удалённая часть)
// и новое: токены удалённых сессий и итог удалённой сессии (M-05). Утверждения те же; отличия названы у блоков.
//   - `SessionInfo` называется `PeerInfo`; `ToolContext` не обязан называть вид у локальной сессии;
//   - `RemoteToolsPort` у плагина уже: `prepare(dirs, host, limits)`, `report(id)` (отметка на хосте; текст ответа даёт `sessions.reportLocal`), `close(id, keep)`;
//   - `hostsOf` асинхронный: хосты проекта спрашиваются у remote-sessions.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PtyHandle } from '@cyborg-harness/contracts';
import { ChildSessions } from '../child-sessions.ts';
import { Delegation } from '../delegation.ts';
import { Registry, type Tab } from '../registry.ts';
import { Tokens } from '../tokens.ts';
import { createSessionTools, describePeers, type PeerInfo, type RemoteToolsPort, sessionTools, validateCloseAgent, validateReport, validateSpawn } from '../tools.ts';

const DIRS = ['/repo/a', '/repo/b'];
const names = (tools: { name: string }[]): string[] => tools.map((t) => t.name);
const peer = (id: number, state: PeerInfo['state'], extra: Partial<PeerInfo> = {}): PeerInfo => ({ id, dirs: DIRS, cwd: '/repo/a', state, queued: 0, ...extra });

describe('набор инструментов по виду сессии', () => {
  it('локальная без хостов проекта - прежний набор, без spawn_agent и close_agent', () => {
    assert.deepEqual(names(sessionTools(DIRS)), ['open_session', 'list_sessions', 'send_to_session', 'close_session']);
  });

  it('локальная с хостами - плюс spawn_agent с перечнем хостов и close_agent', () => {
    const tools = sessionTools(DIRS, { kind: 'local', hosts: ['dev1', 'dev2'] });
    assert.ok(names(tools).includes('spawn_agent') && names(tools).includes('close_agent'));
    const spawn = tools.find((t) => t.name === 'spawn_agent') as unknown as { inputSchema: { properties: { host: { enum: string[] }; repo: { enum: string[] } } } };
    assert.deepEqual(spawn.inputSchema.properties.host.enum, ['dev1', 'dev2']);
    assert.deepEqual(spawn.inputSchema.properties.repo.enum, DIRS);
  });

  it('удалённая - список, сообщение и report_done; порождать и закрывать агентов нельзя', () => {
    assert.deepEqual(names(sessionTools(DIRS, { kind: 'remote', hosts: ['dev1'] })), ['list_sessions', 'send_to_session', 'report_done']);
    // Удалённый агент не открывает и не закрывает сессии на этой машине: у него нет ни open_session, ни close_session.
    assert.ok(!names(sessionTools(DIRS, { kind: 'remote', child: true })).includes('open_session'));
    assert.ok(!names(sessionTools(DIRS, { kind: 'remote', child: true })).includes('close_session'));
  });

  it('report_done удалённой называет ветку и PR, которые запушены на хосте', () => {
    const tool = sessionTools(DIRS, { kind: 'remote' }).find((t) => t.name === 'report_done');
    assert.match(tool?.description ?? '', /ветку запушь и PR открой/);
    assert.match(sessionTools(DIRS, { child: true }).find((t) => t.name === 'report_done')?.description ?? '', /закоммить в свою ветку/);
  });
});

describe('validateSpawn', () => {
  const ok = { host: 'dev1', repo: '/repo/a', branch: 'feat/x', prompt: ' задание ' };

  it('принимает аргументы, keep по умолчанию false, промпт обрезан', () => {
    assert.deepEqual(validateSpawn(ok, DIRS, ['dev1']), { host: 'dev1', repo: '/repo/a', branch: 'feat/x', prompt: 'задание', keep: false });
    assert.deepEqual(validateSpawn({ ...ok, keep: true, limits: { max_agents_per_host: 2, task_timeout_min: 30 } }, DIRS, ['dev1']), {
      host: 'dev1',
      repo: '/repo/a',
      branch: 'feat/x',
      prompt: 'задание',
      keep: true,
      limits: { max_agents_per_host: 2, task_timeout_min: 30 },
    });
  });

  it('отвергает хост и каталог вне проекта, ветку-ключ, пустое задание, неверные пределы', () => {
    assert.match(validateSpawn({ ...ok, host: 'evil' }, DIRS, ['dev1']) as string, /dev1/);
    assert.match(validateSpawn({ ...ok, repo: '/etc' }, DIRS, ['dev1']) as string, /\/repo\/a/);
    assert.equal(typeof validateSpawn({ ...ok, branch: '--upload-pack=x' }, DIRS, ['dev1']), 'string');
    assert.match(validateSpawn({ ...ok, prompt: '  ' }, DIRS, ['dev1']) as string, /непустая/);
    assert.match(validateSpawn({ ...ok, prompt: '- x' }, DIRS, ['dev1']) as string, /«-»/);
    assert.match(validateSpawn({ ...ok, limits: { max_agents_per_host: 99 } }, DIRS, ['dev1']) as string, /от 1 до 16/);
    assert.match(validateSpawn({ ...ok, limits: { foo: 1 } }, DIRS, ['dev1']) as string, /неизвестное поле/);
    assert.match(validateSpawn({ ...ok, keep: 'yes' }, DIRS, ['dev1']) as string, /keep/);
  });
});

describe('validateReport и validateCloseAgent', () => {
  it('report_done: статус из перечня, итог непустой, ветка - имя ref, PR - https', () => {
    assert.deepEqual(validateReport({ status: 'ok', summary: ' готово ', branch: 'feat/x', pr: 'https://h/p/1' }), { status: 'ok', summary: 'готово', branch: 'feat/x', pr: 'https://h/p/1' });
    assert.match(validateReport({ status: 'done', summary: 'x' }) as string, /ok, failed или blocked/);
    assert.match(validateReport({ status: 'ok', summary: ' ' }) as string, /summary/);
    assert.equal(typeof validateReport({ status: 'ok', summary: 'x', branch: '-x' }), 'string');
    assert.match(validateReport({ status: 'ok', summary: 'x', pr: 'http://h' }) as string, /https/);
  });

  it('close_agent: цель - удалённая вкладка проекта', () => {
    const peers = [peer(1, 'waiting'), peer(2, 'waiting', { host: 'dev1' })];
    assert.deepEqual(validateCloseAgent({ id: 2, keep: true }, peers), { id: 2, keep: true });
    assert.deepEqual(validateCloseAgent({ id: 2 }, peers), { id: 2, keep: false });
    assert.match(validateCloseAgent({ id: 1 }, peers) as string, /close_session/);
    assert.match(validateCloseAgent({ id: 9 }, peers) as string, /нет среди вкладок/);
  });

  it('list_sessions показывает хост и обрыв связи удалённой вкладки', () => {
    const list = JSON.parse(describePeers([peer(1, 'waiting'), peer(2, 'waiting', { host: 'dev1', link: 'offline' })], 1)) as { id: number; host?: string; link?: string }[];
    assert.equal(list[0]?.host, undefined);
    assert.equal(list[1]?.host, 'dev1');
    assert.equal(list[1]?.link, 'offline');
  });
});

describe('createSessionTools: удалённая часть', () => {
  function rig(kind: 'local' | 'remote', over: { hosts?: string[] } = {}) {
    const calls: unknown[][] = [];
    const remote: RemoteToolsPort = {
      prepare: async (...a) => void calls.push(['prepare', ...a]),
      report: async (id) => void calls.push(['report', id]),
      close: async (id, keep) => (calls.push(['close', id, keep]), 'закрыта'),
    };
    const requested: unknown[][] = [];
    const peers = [peer(1, 'waiting'), peer(2, 'waiting', { host: 'dev1' }), peer(3, 'working', { host: 'dev1', parent: 1 })];
    const reports: unknown[][] = [];
    const backend = createSessionTools(
      {
        dirsOf: () => DIRS,
        peers: () => peers,
        say: async () => 'sent',
        isChild: () => false,
        reportLocal: (id, report) => (reports.push([id, report]), 'Итог принят.'),
        kindOf: (id) => (id === 2 || id === 3 ? 'remote' : kind),
        hostsOf: async () => over.hosts ?? ['dev1'],
      },
      { request: async (...a) => (requested.push(a), 7) },
      () => assert.fail('вкладку удалённой сессии закрывает удалённая часть'),
      10,
      remote,
    );
    return { backend, calls, requested, reports };
  }

  it('spawn_agent проверяет хост, затем передаёт вкладку с хостом, веткой и keep', async () => {
    const { backend, calls, requested } = rig('local');
    assert.match(await backend.call(1, 'spawn_agent', { host: 'dev1', repo: '/repo/a', branch: 'b', prompt: 'p', keep: true }), /удалённой сессии 7 на dev1/);
    assert.deepEqual(calls, [['prepare', DIRS, 'dev1', undefined]]);
    assert.deepEqual(requested, [[1, '/repo/a', 'p', { host: 'dev1', branch: 'b', keep: true }]]);
  });

  it('без хостов у проекта spawn_agent и close_agent недоступны', async () => {
    const { backend, calls } = rig('local', { hosts: [] });
    assert.deepEqual(names(await backend.tools(1)), ['open_session', 'list_sessions', 'send_to_session', 'close_session']);
    await assert.rejects(backend.call(1, 'spawn_agent', { host: 'dev1', repo: '/repo/a', branch: 'b', prompt: 'p' }), /недоступен этой сессии/);
    assert.deepEqual(calls, []);
  });

  it('удалённая сессия не вызывает spawn_agent и close_agent, даже зная имя', async () => {
    const { backend, calls } = rig('remote');
    await assert.rejects(backend.call(1, 'spawn_agent', { host: 'dev1', repo: '/repo/a', branch: 'b', prompt: 'p' }), /недоступен этой сессии/);
    await assert.rejects(backend.call(1, 'close_agent', { id: 2 }), /недоступен этой сессии/);
    assert.deepEqual(calls, []);
  });

  it('удалённая сессия не вызывает open_session и close_session, а локальная, открытая человеком, - report_done', async () => {
    const { backend, calls, requested } = rig('remote');
    await assert.rejects(backend.call(1, 'open_session', { repo: '/repo/a', prompt: 'p' }), /недоступен этой сессии/);
    await assert.rejects(backend.call(1, 'close_session', { id: 2 }), /недоступен этой сессии/);
    const local = rig('local');
    await assert.rejects(local.backend.call(1, 'report_done', { status: 'ok', summary: 's' }), /недоступен этой сессии/);
    assert.deepEqual([calls, requested, local.calls], [[], [], []]);
  });

  it('report_done удалённой: итог принимает сессия (reportLocal), затем отметка на хосте; близко к ai-cyborg: ответ - текст принятого итога', async () => {
    const { backend, calls, reports } = rig('local');
    assert.equal(await backend.call(2, 'report_done', { status: 'ok', summary: 's' }), 'Итог принят.');
    assert.deepEqual(reports, [[2, { status: 'ok', summary: 's' }]]);
    assert.deepEqual(calls, [['report', 2]]);
  });

  it('close_agent и close_session над удалённой идут в удалённую часть, она же закрывает вкладку', async () => {
    const { backend, calls } = rig('local');
    assert.equal(await backend.call(1, 'close_agent', { id: 2, keep: true }), 'закрыта');
    assert.equal(await backend.call(1, 'close_session', { id: 2 }), 'закрыта');
    assert.deepEqual(calls, [
      ['close', 2, true],
      ['close', 2, false],
    ]);
  });

  it('close_session над работающей удалённой дочерней без force идёт в удалённую часть и убирает клоны', async () => {
    const { backend, calls } = rig('local');
    assert.equal(await backend.call(1, 'close_session', { id: 3 }), 'закрыта');
    assert.deepEqual(calls, [['close', 3, false]]);
  });
});

describe('токены удалённых сессий: Tokens.adopt', () => {
  const TOKEN = 'A'.repeat(43);

  it('принимается для сессии с выданным токеном: выданный заменён, принятый называет сессию', () => {
    const tokens = new Tokens();
    const issued = tokens.issue('s1');
    assert.equal(tokens.adopt('s1', TOKEN), true);
    assert.equal(tokens.sessionOf(TOKEN), 's1');
    assert.equal(tokens.sessionOf(issued), undefined, 'выданный токен отозван: удалённая сессия ходит только со своим');
    tokens.revoke('s1');
    assert.equal(tokens.sessionOf(TOKEN), undefined, 'выход сессии отзывает и принятый токен');
  });

  it('сессия без выданного токена, чужая форма и токен другой сессии не принимаются', () => {
    const tokens = new Tokens();
    assert.equal(tokens.adopt('s1', TOKEN), false, 'сессии нет');
    tokens.issue('s1');
    tokens.issue('s2');
    for (const bad of ['короткий', `${TOKEN}A`, `${TOKEN.slice(1)}+`, `${'A'.repeat(42)} `, '']) assert.equal(tokens.adopt('s1', bad), false, JSON.stringify(bad));
    assert.equal(tokens.adopt('s1', TOKEN), true);
    assert.equal(tokens.adopt('s2', TOKEN), false, 'токен уже у другой сессии');
    assert.equal(tokens.sessionOf(TOKEN), 's1');
  });
});

describe('итог удалённой сессии (Delegation.reportLocal)', () => {
  function rig() {
    const registry = new Registry(() => undefined);
    const stored = new Map<string, string>();
    const children = new ChildSessions('/c.json', { readText: async (f) => stored.get(f) ?? Promise.reject(new Error('нет')), writeText: async (f, t) => void stored.set(f, t) });
    const notes: string[] = [];
    const delegation = new Delegation({ registry, children, log: () => undefined, announce: () => undefined, closeTab: async () => undefined, notify: (t, b) => void notes.push(`${t}|${b}`), revoke: () => undefined, quietMs: 0 });
    const writes: string[] = [];
    const open = (sessionId: string, title: string, lineage = {}): Tab => {
      const handle = { id: 1, pid: 1, write: async (d: string) => void writes.push(d), resize: async () => undefined, kill: async () => undefined, onExit: () => ({ dispose() {} }), share: async () => 't' } as unknown as PtyHandle;
      const tab: Tab = { sessionId, doc: `d-${sessionId}`, title, agent: 'remote-sessions', dirs: ['/a'], handle };
      registry.add(tab);
      delegation.attach(tab, lineage);
      return tab;
    };
    return { delegation, notes, open, writes, registry };
  }

  it('удалённая без открывшей: итог - уведомление рабочего стола с хостом; повтор за круг - отказ', () => {
    const r = rig();
    r.open('s1', 'Claude Code 1');
    r.delegation.setRemote('s1', { host: 'dev1', sid: 'a'.repeat(8) });
    assert.equal(r.delegation.kindOf(1), 'remote');
    assert.match(r.delegation.reportLocal(1, { status: 'ok', summary: 'готово' }), /Итог принят/);
    assert.deepEqual(r.notes, ['CC1 · dev1|ok: готово']);
    assert.throws(() => r.delegation.reportLocal(1, { status: 'ok', summary: 'ещё' }), /уже отправлен/);
  });

  it('локальная без открывшей по-прежнему не сдаёт итог', () => {
    const r = rig();
    r.open('s1', 'Claude Code 1');
    assert.equal(r.delegation.kindOf(1), 'local');
    assert.throws(() => r.delegation.reportLocal(1, { status: 'ok', summary: 'x' }), /открытой другой сессией/);
  });

  it('удалённая дочерняя: итог уходит в очередь открывшей с хостом в заголовке; в peers у неё host, после forget привязка снята', () => {
    const r = rig();
    const parent = r.open('p', 'Claude Code 1');
    r.delegation.event(parent, { type: 'session', resumeId: 'x' });
    r.open('c', 'Claude Code 2', { parent: 'p', parentNumber: 1 });
    r.delegation.setRemote('c', { host: 'dev1', sid: 'b'.repeat(8) });
    assert.equal(r.delegation.peers(1)?.find((p) => p.id === 2)?.host, 'dev1');
    assert.equal(r.delegation.peers(1)?.find((p) => p.id === 1)?.host, undefined);
    r.delegation.reportLocal(2, { status: 'blocked', summary: 'нужен человек', branch: 'feat/x' });
    assert.deepEqual(r.notes, [], 'открывшая есть - уведомления нет');
    r.delegation.forget('c');
    assert.equal(r.delegation.remoteOf('c'), undefined);
  });
});
