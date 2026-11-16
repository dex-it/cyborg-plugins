import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { bundle, CLAUDE_TOKEN, manifest, rig, until } from './kit.ts';

/** Файлы под каталогом, в которых встречается строка. */
function filesWith(dir: string, needle: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesWith(file, needle));
    else if (entry.isFile() && readFileSync(file, 'utf8').includes(needle)) found.push(file);
  }
  return found;
}

interface Info {
  resumeId: string;
  sid: string;
  host: string;
  dirs: string[];
  cwd: string;
  roots: string[];
  notes: string[];
}

describe('создание и запуск удалённой сессии на подставном хосте с настоящим демоном', () => {
  it('remote-sessions.create клонирует репозиторий проекта на хост под ключом ветки; ответ - resumeId, клон и корни', async () => {
    await using r = await rig({ repos: true });
    assert.ok(r.repos);
    const info = (await r.call('remote-sessions.create', 'p1', { host: 'dev1', repo: r.repos.work.dir, branch: 'feat/x' })) as Info;
    assert.match(info.resumeId, /^[0-9a-f-]{36}@dev1$/);
    assert.equal(info.resumeId, `${info.sid}@dev1`);
    assert.deepEqual(info.dirs, [r.repos.work.dir]);
    assert.ok(info.cwd.startsWith(r.cyborg('work', info.sid)), info.cwd);
    assert.deepEqual(info.roots, [info.cwd]);
    // Клонирование идёт в фоне демона: клон с нужной веткой появляется следом за ответом.
    await until('клон на хосте на ветке feat/x', () => existsSync(path.join(info.cwd, '.git', 'HEAD')) && readFileSync(path.join(info.cwd, '.git', 'HEAD'), 'utf8').includes('feat/x'));
    assert.equal(statSync(r.cyborg('sessions', info.sid)).mode & 0o777, 0o700);
    const meta = JSON.parse(readFileSync(r.cyborg('sessions', info.sid, 'meta.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(meta.branch, 'feat/x');
    assert.deepEqual(meta.limits, { maxPerHost: 4, taskMs: 4 * 3600_000, idleMs: 30 * 60_000 });
    // Токен Claude, токены gh и glab и токен сессии на диск хоста не пишутся (NFR-17001).
    assert.deepEqual(filesWith(r.cyborg(), CLAUDE_TOKEN), [], 'токен Claude в файлах хоста');
    assert.deepEqual(r.sshLog().filter((c) => c.includes(CLAUDE_TOKEN)), [], 'токен Claude в аргументах ssh');
  });

  it('аргументы create проверяются: хост не из проекта, чужой репозиторий, ветка с «-», задание из окна не принимается', async () => {
    await using r = await rig({ repos: true });
    assert.ok(r.repos);
    const base = { host: 'dev1', repo: r.repos.work.dir, branch: 'ok' };
    await assert.rejects(r.call('remote-sessions.create', 'p1', { ...base, host: 'evil' }), /хост не из списка проекта/);
    await assert.rejects(r.call('remote-sessions.create', 'p1', { ...base, repo: '/etc' }), /репозиторий не из проекта/);
    await assert.rejects(r.call('remote-sessions.create', 'p1', { ...base, branch: '-x' }), /«-»/);
    await assert.rejects(r.call('remote-sessions.create', 'нет', base), /Некорректные аргументы/);
    assert.deepEqual(r.sshLog(), [], 'до проверки аргументов ssh не запускался');
  });

  it('launch по resumeId описывает ssh -tt к демону: закреплённые аргументы, attach своей сессии, экземпляр Cyborg; запуск через потребителя проходит по праву pty', async () => {
    await using r = await rig({ repos: true, env: { SSH_AUTH_SOCK: '/tmp/agent-test.sock' } });
    assert.ok(r.repos);
    const info = (await r.call('remote-sessions.create', 'p1', { host: 'dev1', repo: r.repos.work.dir, branch: 'b1' })) as Info;
    const spec = await r.agent.launch({ sessionId: 'tab-1', cwd: r.repos.work.dir, resumeId: info.resumeId });
    const v = (await bundle()).version;
    assert.equal(spec.program, 'ssh');
    assert.deepEqual(spec.args.slice(0, 12), manifest.permissions.launch[0]?.args);
    assert.equal(spec.args.at(-2), 'dev1');
    assert.match(spec.args.at(-1) ?? '', new RegExp(`^sh \\.cyborg/agentd/${v}/client\\.sh attach ${info.sid} [0-9a-f-]{36}$`));
    assert.equal(spec.cwd, r.repos.work.dir);
    assert.deepEqual(spec.env, { SSH_AUTH_SOCK: '/tmp/agent-test.sock' }, 'ключи ssh-agent доходят до ssh, прочее окружение - нет');
    const pty = r.consumer.os.pty;
    assert.ok(pty);
    const before = r.kernel.pty.procs.length;
    await pty.spawn({ ...spec, cols: 120, rows: 32, describedBy: 'remote-sessions' });
    assert.equal(r.kernel.pty.procs[before]?.file, 'ssh');
    assert.deepEqual(r.kernel.pty.procs[before]?.args, spec.args);
    assert.deepEqual(r.kernel.journal.filter((e) => e.kind === 'denied' || e.kind === 'failed'), []);
  });

  it('launch отвергает хост вне проектов, сессию, которой нет на хосте, и resumeId чужой формы - без цели терминал печатает причину', async () => {
    await using r = await rig({ repos: true });
    assert.ok(r.repos);
    const cwd = r.repos.work.dir;
    await assert.rejects(r.agent.launch({ sessionId: 't', cwd, resumeId: '11111111-1111-1111-1111-111111111111@evil' }), /хост не из списка/);
    await assert.rejects(r.agent.launch({ sessionId: 't', cwd, resumeId: '11111111-1111-1111-1111-111111111111@dev1' }), /не найдена на dev1/);
    for (const resumeId of [undefined, 'abc', '-oProxyCommand=x@dev1', 'не@uuid']) {
      const spec = await r.agent.launch({ sessionId: 't', cwd, ...(resumeId !== undefined && { resumeId }) });
      assert.equal(spec.program, '$SHELL', String(resumeId));
      assert.equal(spec.args[1], manifest.permissions.launch[1]?.args[1]);
    }
  });

  it('терминал из launch (ssh -tt ... attach): вывод claude, ввод доходит до него, обрыв ssh не убивает сессию, новый launch подхватывает её с прежним выводом', async () => {
    await using r = await rig({ repos: true });
    assert.ok(r.repos);
    const cwd = r.repos.work.dir;
    const info = (await r.call('remote-sessions.create', 'p1', { host: 'dev1', repo: cwd, branch: 'b2' })) as Info;
    const attach = async (id: string) => {
      const spec = await r.agent.launch({ sessionId: id, cwd, resumeId: info.resumeId });
      const child = spawn(spec.program, [...spec.args], { env: { ...r.box.env }, stdio: 'pipe' });
      const term = { out: '' };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => (term.out += d));
      const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
      return { child, term, closed };
    };
    // Первое окно: подставной claude под демоном приветствует и отвечает эхом на введённую строку.
    const first = await attach('tab-a');
    await until('claude на хосте готов', () => first.term.out.includes('fake-claude ready'));
    first.child.stdin.write('привет\n');
    await until('ввод дошёл до claude и вернулся выводом', () => first.term.out.includes('got: [привет]'));
    // Обрыв связи: ssh убит, как при потере сети; claude на хосте об этом не знает.
    first.child.kill('SIGKILL');
    await first.closed;
    assert.ok(existsSync(r.cyborg('sessions', info.sid, 'meta.json')), 'сессия на хосте жива');
    // Подхват: новый launch с тем же resumeId получает прежний вывод из кольца демона и продолжает ввод.
    const second = await attach('tab-b');
    await until('прежний вывод из кольца', () => second.term.out.includes('got: [привет]'));
    second.child.stdin.write('снова\n');
    await until('ввод после подхвата', () => second.term.out.includes('got: [снова]'));
    second.child.stdin.end();
    await second.closed;
  });

  it('remote:fs и remote:search на настоящем демоне: дерево, ветка и содержимое клона читаются, путь вне клонов отвергает демон', async () => {
    await using r = await rig({ repos: true });
    assert.ok(r.repos);
    const info = (await r.call('remote-sessions.create', 'p1', { host: 'dev1', repo: r.repos.work.dir, branch: 'feat/read' })) as Info;
    await until('клон на ветке feat/read', () => existsSync(path.join(info.cwd, 'README.md')) && readFileSync(path.join(info.cwd, '.git', 'HEAD'), 'utf8').includes('feat/read'));
    assert.equal(await r.call('remote-sessions.fs', info.resumeId, 'branch', info.cwd), 'feat/read');
    assert.match(JSON.stringify(await r.call('remote-sessions.fs', info.resumeId, 'list', info.cwd)), /README\.md/);
    assert.match(JSON.stringify(await r.call('remote-sessions.fs', info.resumeId, 'read', `${info.cwd}/README.md`)), /Фикстура/);
    assert.match(JSON.stringify(await r.call('remote-sessions.fs', info.resumeId, 'files', info.cwd)), /README\.md/);
    // Правка и смена ветки каналом не доступны; путь вне клонов - отказ демона, а не чтение чужого файла.
    await assert.rejects(r.call('remote-sessions.fs', info.resumeId, 'write', info.cwd), /Некорректная/);
    await assert.rejects(r.call('remote-sessions.fs', info.resumeId, 'read', '/etc/passwd'), /вне|не найден|Путь/i);
    const hits = (await r.call('remote-sessions.search', info.resumeId, 'text', { root: info.cwd, query: 'Фикстура', options: { regex: false, caseSensitive: true, wholeWord: false } })) as { hits: { rel: string; line: number }[] };
    assert.deepEqual(hits.hits.map((h) => [h.rel, h.line]), [['README.md', 1]]);
  });

  it('события: хуки claude на хосте доходят до watch опросом файла сессии; прошлое подхваченной живой сессии не повторяется', async () => {
    await using r = await rig({ repos: true });
    assert.ok(r.repos);
    const info = (await r.call('remote-sessions.create', 'p1', { host: 'dev1', repo: r.repos.work.dir, branch: 'ev' })) as Info;
    const events = r.cyborg('sessions', info.sid, 'events.jsonl');
    // Сессия живёт под подставным claude: он пишет SessionStart в файл событий сам.
    await until('claude на хосте записал SessionStart', () => existsSync(events) && readFileSync(events, 'utf8').includes('SessionStart'));
    const spec = await r.agent.launch({ sessionId: 'tab-ev', cwd: r.repos.work.dir, resumeId: info.resumeId });
    assert.equal(spec.program, 'ssh');
    const heard: { type: string; tool?: string }[] = [];
    const sub = await r.agent.watch('tab-ev', (e) => heard.push(e));
    try {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      assert.deepEqual(heard, [], 'события до подхвата уже показаны');
      appendFileSync(events, `${JSON.stringify({ hook_event_name: 'UserPromptSubmit' })}\n${JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit' })}\n`);
      await until('prompt и activity', () => heard.length >= 2, 15_000);
      assert.deepEqual(heard.slice(0, 2), [{ type: 'prompt' }, { type: 'activity', tool: 'Edit' }]);
    } finally {
      await sub.dispose();
    }
  });

  it('лимит хоста: пятая живая сессия отвергается демоном с числом 4; закрытие одной освобождает место', async () => {
    await using r = await rig({ repos: true });
    assert.ok(r.repos);
    const make = (branch: string) => r.call('remote-sessions.create', 'p1', { host: 'dev1', repo: r.repos?.work.dir, branch }) as Promise<Info>;
    const made: Info[] = [];
    for (const branch of ['l1', 'l2', 'l3', 'l4']) {
      made.push(await make(branch));
      // Демон считает живыми сессии с процессом: следующая создаётся, когда прежняя запущена.
      const info = made.at(-1) as Info;
      await until(`${branch} запущена`, () => existsSync(r.cyborg('sessions', info.sid, 'events.jsonl')));
    }
    await assert.rejects(make('l5'), /уже 4 удалённых сессий \(предел 4\)/);
    const first = made[0] as Info;
    assert.match((await r.call('remote-sessions.close', first.resumeId, false)) as string, /Сессия [0-9a-f]{8} завершена/);
    const again = await make('l5');
    assert.match(again.resumeId, /@dev1$/);
  });

  it('close без keep убирает клоны, с keep оставляет; remote:purge убирает оставленные клоны (грязные - только с force), работающую не трогает', async () => {
    await using r = await rig({ repos: true });
    assert.ok(r.repos);
    const create = async (branch: string) => (await r.call('remote-sessions.create', 'p1', { host: 'dev1', repo: r.repos?.work.dir, branch })) as Info;
    const ready = (info: Info) => until('клон на ветке', () => existsSync(path.join(info.cwd, 'README.md')) && existsSync(r.cyborg('sessions', info.sid, 'events.jsonl')));
    const gone = await create('c1');
    await ready(gone);
    await r.call('remote-sessions.close', gone.resumeId, false);
    await until('клоны убраны', () => !existsSync(r.cyborg('work', gone.sid)));

    const kept = await create('c2');
    await ready(kept);
    const text = (await r.call('remote-sessions.close', kept.resumeId, true)) as string;
    assert.match(text, /завершена/);
    await until('процесс остановлен, клон остался', () => existsSync(path.join(kept.cwd, 'README.md')));
    const disk = (await r.call('remote-sessions.disk', 'p1', 'dev1')) as { sessions: { sid: string; state: string }[] };
    assert.equal(disk.sessions.find((x) => x.sid === kept.sid)?.state, 'done');
    // Незапушенная работа в оставленном клоне: без force purge её не трогает.
    writeFileSync(path.join(kept.cwd, 'work.txt'), 'не запушено\n');
    const live = await create('c3');
    await ready(live);
    const refused = (await r.call('remote-sessions.purge', 'p1', 'dev1', [kept.sid, live.sid], false)) as { sid: string; removed: string[]; kept: { path: string; reason: string }[]; error?: string }[];
    assert.equal(refused.find((x) => x.sid === live.sid)?.error, 'сессия работает: её закрывают вкладкой');
    assert.equal(refused.find((x) => x.sid === kept.sid)?.kept.length, 1, 'грязный клон остался');
    assert.ok(existsSync(path.join(kept.cwd, 'work.txt')));
    const forced = (await r.call('remote-sessions.purge', 'p1', 'dev1', [kept.sid], true)) as { removed: string[] }[];
    assert.ok((forced[0]?.removed.length ?? 0) > 0);
    assert.equal(existsSync(r.cyborg('work', kept.sid)), false, 'purge убрал клоны');
    assert.ok(existsSync(path.join(live.cwd, 'README.md')), 'работающая сессия цела');
  });
});
