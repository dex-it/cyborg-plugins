// Служба удалённых сессий на подставных хостах (ответы демона задаёт тест): отбор сессий проекта, «История» с недоступным хостом, пробуждение, уборка, границы аргументов.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProjectView } from '../args.ts';
import type { Host, Msg } from '../host.ts';
import { closeText, hostText, RemoteService, resumeIdOf, type ServiceDeps } from '../service.ts';

const SID_A = '11111111-1111-1111-1111-111111111111';
const SID_B = '22222222-2222-2222-2222-222222222222';
const SID_C = '33333333-3333-3333-3333-333333333333';
const project: ProjectView = { repos: ['/r/a', '/r/b'], hosts: ['dev1', 'dev2'] };

/** Сессия SID_A известна на dev1: служба не опрашивает хосты, а ответы заглушки заданы под один запрос. */
const onDev1 = (): Map<string, string> => new Map([[SID_A, 'dev1']]);

type Handler = (msg: Record<string, unknown>) => Msg | Promise<Msg>;

function stubHost(alias: string, handler: Handler, log: Record<string, unknown>[] = []): Host {
  return {
    host: alias,
    tools: { gh: false, glab: false },
    config: null,
    disk: null,
    ensure: () => Promise.resolve(),
    request: async (msg: Record<string, unknown>) => {
      log.push(msg);
      return handler(msg);
    },
  } as unknown as Host;
}

function service(hosts: Record<string, Host>, extra: Partial<ServiceDeps> = {}, known: Map<string, string> = new Map()): RemoteService {
  return new RemoteService({
    hostOf: (sid) => known.get(sid),
    remember: (sid, host) => void known.set(sid, host),
    aliases: () => Object.keys(hosts),
    host: (alias) => hosts[alias] ?? stubHost(alias, () => ({ type: 'error', message: 'нет хоста' })),
    project: async (id) => (id === 'p1' ? project : undefined),
    originUrl: async (dir) => `git@gl.example.com:o/${dir.slice(3)}.git`,
    gitAuth: async () => [{ kind: 'gitlab', host: 'gl.example.com', token: 'glpat-X' }],
    claudeToken: async () => null,
    uuid: () => SID_A,
    secret: () => 's'.repeat(64),
    ...extra,
  });
}

const item = (sid: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ sid, dirs: ['/r/b', '/r/a'], cwd: `/h/work/${sid}/a`, clones: [`/h/work/${sid}/a`, `/h/work/${sid}/b`], branch: 'feat', lastActive: 5, token: 't', ...extra });

describe('resumeId = идентификатор сессии на хосте; хост находит locate', () => {
  it('resumeId проходит проверку sessions (^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$): UUID без «@» и хоста', () => {
    assert.equal(resumeIdOf(SID_A), SID_A);
    assert.match(SID_A, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  });

  it('locate: запомненный хост без опроса; незапомненный находится опросом хостов проектов и запоминается; негодная форма - null; нет нигде - отказ', async () => {
    const asked: string[] = [];
    const dev1 = stubHost('dev1', () => (asked.push('dev1'), { type: 'list', sessions: [item(SID_A)] }));
    const dev2 = stubHost('dev2', () => (asked.push('dev2'), { type: 'list', sessions: [item(SID_B)] }));
    const known = new Map<string, string>([[SID_C, 'dev1']]);
    const svc = service({ dev1, dev2 }, {}, known);
    assert.equal((await svc.locate(SID_C))?.alias, 'dev1');
    assert.deepEqual(asked, [], 'запомненное не опрашивается');
    assert.equal((await svc.locate(SID_B))?.alias, 'dev2');
    assert.equal(known.get(SID_B), 'dev2', 'найденное запоминается');
    asked.length = 0;
    assert.equal((await svc.locate(SID_B))?.alias, 'dev2');
    assert.deepEqual(asked, []);
    for (const bad of [undefined, 5, 'abc', `${SID_A}@dev1`, '-x', '']) assert.equal(await svc.locate(bad), null, String(bad));
    await assert.rejects(svc.locate('44444444-4444-4444-4444-444444444444'), /не найдена на хостах проектов/);
  });

  it('locate: запомненный хост, которого больше нет в проектах, не используется - сессия ищется заново; недоступный хост поиск не рушит', async () => {
    const dev1 = stubHost('dev1', () => ({ type: 'list', sessions: [item(SID_A)] }));
    const down = stubHost('dev2', () => Promise.reject(new Error('нет связи')));
    const known = new Map<string, string>([[SID_A, 'ушедший-хост']]);
    const svc = service({ dev2: down, dev1 }, {}, known);
    assert.equal((await svc.locate(SID_A))?.alias, 'dev1');
    assert.equal(known.get(SID_A), 'dev1');
  });
});

describe('remote:create: что уходит демону', () => {
  it('spawn с репозиториями проекта (выбранный по индексу), веткой, лимитами 4 / 4 ч / 30 мин и доступами; токен Claude и gh/glab - только в сообщении демону', async () => {
    const log: Record<string, unknown>[] = [];
    const dev1 = stubHost('dev1', () => ({ type: 'spawn', sid: SID_A, cwd: `/h/work/${SID_A}/b`, clones: [`/h/work/${SID_A}/a`, `/h/work/${SID_A}/b`] }), log);
    const svc = service({ dev1 }, { claudeToken: async () => 'sk-ant-oat01-secret' });
    const info = await svc.create('p1', { host: 'dev1', repo: '/r/b', branch: 'feat/x', prompt: 'игнорируется для человека' });
    const spawn = log.find((m) => m.type === 'spawn') as Record<string, unknown>;
    assert.equal(spawn.sid, SID_A);
    assert.equal(spawn.branch, 'feat/x');
    assert.equal(spawn.selected, 1);
    assert.equal('prompt' in spawn, false, 'задание из окна не принимается');
    assert.deepEqual(spawn.repos, [
      { local: '/r/a', url: 'git@gl.example.com:o/a.git', name: 'a' },
      { local: '/r/b', url: 'git@gl.example.com:o/b.git', name: 'b' },
    ]);
    assert.deepEqual(spawn.limits, { maxPerHost: 4, taskMs: 4 * 3600_000, idleMs: 30 * 60_000 });
    assert.deepEqual(spawn.auth, { git: [{ kind: 'gitlab', host: 'gl.example.com', token: 'glpat-X' }], primary: 'gl.example.com', claude: 'sk-ant-oat01-secret' });
    assert.equal(spawn.keep, false);
    assert.equal(spawn.origin, 'human');
    assert.deepEqual(info.dirs, ['/r/b', '/r/a']);
    assert.equal(info.cwd, `/h/work/${SID_A}/b`);
    assert.deepEqual(info.roots, [`/h/work/${SID_A}/b`, `/h/work/${SID_A}/a`]);
    assert.ok(info.notes?.some((n) => /на хосте нет glab/.test(n)));
  });

  it('createWithPrompt (инструмент spawn_agent) передаёт задание; origin с учётными данными - без них, с пометкой; origin без адреса - отказ', async () => {
    const log: Record<string, unknown>[] = [];
    const dev1 = stubHost('dev1', () => ({ type: 'spawn', sid: SID_A, cwd: '/c', clones: [] }), log);
    const svc = service({ dev1 }, { originUrl: async (d) => (d === '/r/a' ? 'https://oauth2:glpat-LEAK@gl.example.com/o/a.git' : 'git@gl.example.com:o/b.git') });
    const info = await svc.createWithPrompt('p1', { host: 'dev1', repo: '/r/a', branch: 'b', prompt: 'сделай' });
    const spawn = log[0] as { prompt?: string; repos: { url: string }[] };
    assert.equal(spawn.prompt, 'сделай');
    assert.equal(spawn.repos[0]?.url, 'https://gl.example.com/o/a.git');
    assert.equal(JSON.stringify(log).includes('LEAK'), false, 'токен из адреса origin демону не уходит');
    assert.ok(info.notes?.some((n) => /содержит учётные данные/.test(n)));
    const none = service({ dev1 }, { originUrl: async () => null });
    await assert.rejects(none.create('p1', { host: 'dev1', repo: '/r/a', branch: 'b' }), /нет origin/);
    const dash = service({ dev1 }, { originUrl: async () => '-oProxyCommand=x' });
    await assert.rejects(dash.create('p1', { host: 'dev1', repo: '/r/a', branch: 'b' }), /начинается с «-»/);
  });

  it('отказ демона (предел сессий на хосте) доходит до человека текстом демона', async () => {
    const dev1 = stubHost('dev1', () => Promise.reject(new Error('на хосте уже 4 удалённых сессий (предел 4)')));
    await assert.rejects(service({ dev1 }).create('p1', { host: 'dev1', repo: '/r/a', branch: 'b' }), /предел 4/);
  });
});

describe('remote:discover и history:remote', () => {
  const dev1 = stubHost('dev1', () => ({
    type: 'list',
    sessions: [
      item(SID_A),
      item(SID_B, { busy: true }),
      item(SID_C, { asleep: true, title: 'Разговор\x1b[31m' }),
      item('44444444-4444-4444-4444-444444444444', { exited: true }),
      item('55555555-5555-5555-5555-555555555555', { dirs: ['/r/other'] }),
      item('не-uuid'),
    ],
  }));
  const dev2 = stubHost('dev2', () => Promise.reject(new Error('хост требует пароль')));

  it('discover: живые сессии проекта по тем же репозиториям, не занятые другим окном; недоступный хост назван, а не молчит', async () => {
    const found = await service({ dev1, dev2 }).discover('p1');
    assert.deepEqual(found.sessions.map((s) => s.resumeId), [SID_A]);
    assert.deepEqual(found.sessions[0]?.roots, [`/h/work/${SID_A}/a`, `/h/work/${SID_A}/b`]);
    assert.deepEqual(found.unreachable, [{ host: 'dev2', reason: 'хост требует пароль' }]);
    await assert.rejects(service({ dev1 }).discover('нет'), /проект не найден/);
  });

  it('history: спящие сессии проекта, заголовок очищен от управляющих символов; недоступный хост в unreachable', async () => {
    const h = await service({ dev1, dev2 }).history('p1');
    assert.deepEqual(h.entries, [{ id: SID_C, cwd: '/r/b', title: 'Разговор[31m', updated: 5, host: 'dev1' }]);
    assert.deepEqual(h.unreachable.map((u) => u.host), ['dev2']);
  });

  it('history: хост, не ответивший за предел, не держит «Историю»', async () => {
    const hung = stubHost('dev2', () => new Promise<Msg>(() => undefined));
    const t0 = Date.now();
    const h = await service({ dev1, dev2: hung }, { historyTimeoutMs: 50 }).history('p1');
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(h.entries.length, 1);
    assert.match(h.unreachable[0]?.reason ?? '', /не ответил/);
  });
});

describe('remote:wake, remote:remove-asleep, remote:purge, remote:disk, закрытие', () => {
  it('wake: только спящая сессия проекта; шлёт wake с доступами и свежим токеном; ответ - те же клоны', async () => {
    const log: Record<string, unknown>[] = [];
    const dev1 = stubHost(
      'dev1',
      (m) => (m.type === 'list' ? { type: 'list', sessions: [item(SID_A), item(SID_C, { asleep: true })] } : { type: 'wake', sid: SID_C, cwd: '/h/c', clones: ['/h/c', '/h/d'], round: 2 }),
      log,
    );
    const svc = service({ dev1 });
    const info = await svc.wake('p1', 'dev1', SID_C);
    const wake = log.find((m) => m.type === 'wake') as Record<string, unknown>;
    assert.equal(wake.sid, SID_C);
    assert.equal(wake.token, 's'.repeat(64));
    assert.deepEqual(wake.cols, 120);
    assert.deepEqual((wake.auth as { git: unknown[] }).git.length, 1);
    assert.equal(info.resumeId, SID_C);
    assert.deepEqual(info.roots, ['/h/c', '/h/d']);
    await assert.rejects(svc.wake('p1', 'dev1', SID_A), /спящая сессия не найдена/);
    await assert.rejects(svc.wake('p1', 'evil', SID_C), /хост не из списка проекта/);
    await assert.rejects(svc.wake('p1', 'dev1', 'не-uuid'), /Некорректное пробуждение/);
  });

  it('remove-asleep: close без keep; отказ уборки возвращается текстом, чистая уборка - пустой строкой', async () => {
    const replies = [{ type: 'close', removed: ['/h/a'], kept: [] }, { type: 'close', removed: [], kept: [{ path: '/h/a', reason: 'не запушено' }] }];
    const log: Record<string, unknown>[] = [];
    const dev1 = stubHost('dev1', () => replies.shift() as Msg, log);
    const svc = service({ dev1 });
    assert.equal(await svc.removeAsleep('p1', 'dev1', SID_C), '');
    assert.equal(await svc.removeAsleep('p1', 'dev1', SID_C), `Сессия ${SID_C.slice(0, 8)} завершена. Уборка отказана - оставлены dev1:/h/a (не запушено).`);
    assert.deepEqual(log[0], { type: 'close', sid: SID_C, keep: false });
    await assert.rejects(svc.removeAsleep('p1', 'dev1', 'x'), /Некорректное удаление/);
  });

  it('purge: список из UUID, force только булевым true; ответ разобран (пути и тексты очищены)', async () => {
    const log: Record<string, unknown>[] = [];
    const dev1 = stubHost('dev1', () => ({ type: 'purge', results: [{ sid: SID_A, removed: ['/h/a'], kept: [{ path: '/h/b', reason: 'грязный\x07' }] }] }), log);
    const svc = service({ dev1 });
    const out = await svc.purge('p1', 'dev1', [SID_A], 'да');
    assert.deepEqual(log[0], { type: 'purge', sids: [SID_A], force: false });
    assert.deepEqual(out, [{ sid: SID_A, removed: ['/h/a'], kept: [{ path: '/h/b', reason: 'грязный ' }] }]);
    await svc.purge('p1', 'dev1', [SID_A], true);
    assert.equal(log[1]?.force, true);
    await assert.rejects(svc.purge('p1', 'dev1', ['../x'], false), /Некорректное удаление/);
    await assert.rejects(svc.purge('p1', 'dev1', 'x', false), /Некорректное удаление/);
  });

  it('disk: ответ демона разобран; хост не из проекта - отказ', async () => {
    const dev1 = stubHost('dev1', () => ({ type: 'disk', free: 5, total: 10, sessions: [{ sid: SID_A, state: 'asleep', bytes: 1024, title: 'т', branch: 'b', dirs: ['/r/a'], lastActive: 3, dirty: [], measured: true }, { sid: 'мусор' }] }));
    const disk = await service({ dev1 }).disk('p1', 'dev1');
    assert.equal(disk.host, 'dev1');
    assert.equal(disk.sessions.length, 1);
    assert.equal(disk.sessions[0]?.state, 'asleep');
    await assert.rejects(service({ dev1 }).disk('p1', 'evil'), /хост не из списка проекта/);
  });

  it('close: по resumeId, keep булевый; текст итога называет клоны', async () => {
    const log: Record<string, unknown>[] = [];
    const dev1 = stubHost('dev1', () => ({ type: 'close', removed: ['/h/a'], kept: [] }), log);
    const text = await service({ dev1 }, {}, onDev1()).close(SID_A, undefined);
    assert.equal(text, `Сессия ${SID_A.slice(0, 8)} завершена. Клоны удалены: /h/a.`);
    assert.deepEqual(log[0], { type: 'close', sid: SID_A, keep: false });
    assert.equal(log[1]?.type, 'attach', 'после закрытия запись снимается attach: владелец получает exit');
    await assert.rejects(service({ dev1 }, {}, onDev1()).close('abc', false), /Некорректный номер/);
  });

  it('текст с хоста недоверен: управляющие символы вычищены, длина ограничена', () => {
    assert.equal(hostText('a\x1b[31mb\x00'), 'a[31mb');
    assert.equal(hostText('я'.repeat(5000)).length, 2000);
    assert.equal(hostText(5), '');
    assert.equal(closeText('s', 'h', { removed: [], kept: [] }), 'Сессия s завершена.');
  });
});

describe('remote:fs и remote:search: только чтение и в границах', () => {
  it('fs: операции из читающего списка, абсолютный путь без «..»; запись и смена ветки отвергаются до хоста', async () => {
    const log: Record<string, unknown>[] = [];
    const dev1 = stubHost('dev1', (m) => ({ type: 'fs', value: m.op === 'read' ? 'текст' : ['a.ts'] }), log);
    const svc = service({ dev1 }, {}, onDev1());
    assert.equal(await svc.fs(SID_A, 'read', '/h/work/a/x.ts'), 'текст');
    assert.deepEqual(log[0], { type: 'fs', sid: SID_A, op: 'read', path: '/h/work/a/x.ts' });
    for (const [op, p] of [['write', '/h/a'], ['switch', '/h/a'], ['read', '../etc'], ['read', '/h/../etc'], ['read', 5]] as const) await assert.rejects(svc.fs(SID_A, op, p), /Некорректная|вне каталогов/, `${op} ${String(p)}`);
    assert.equal(log.length, 1);
  });

  it('fs: ошибка демона (путь вне клонов) - отказ с её текстом', async () => {
    const dev1 = stubHost('dev1', () => ({ type: 'fs', error: 'путь вне клонов сессии' }));
    await assert.rejects(service({ dev1 }, {}, onDev1()).fs(SID_A, 'list', '/etc'), /вне клонов/);
  });

  it('search: режим text или changes, корень абсолютный; ответ хоста проходит проверку формы', async () => {
    const log: Record<string, unknown>[] = [];
    const dev1 = stubHost('dev1', () => ({ type: 'search', value: { hits: [{ rel: 'a.ts', line: 1, text: 'x', range: null }, { rel: '/etc/passwd', line: 1, text: 'y' }], truncated: false } }), log);
    const svc = service({ dev1 }, {}, onDev1());
    const reply = await svc.search(SID_A, 'text', { root: '/h/work/a', pattern: 'x' });
    assert.deepEqual(reply.hits.map((h) => h.rel), ['a.ts']);
    assert.equal(log[0]?.mode, 'text');
    await assert.rejects(svc.search(SID_A, 'exec', { root: '/h' }), /Некорректный поиск/);
    await assert.rejects(svc.search(SID_A, 'text', { root: 'h/work' }), /вне каталогов/);
  });
});
