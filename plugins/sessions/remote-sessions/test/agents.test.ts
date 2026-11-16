// spawn_agent, report_done, close_agent и круги работы (FR-17008..17010) для удалённых сессий: сценарий вроде S19 и S21 на подставном хосте. Настоящие `sessions` с сервером MCP,
// `remote-sessions` и демон; локальный руководитель - сессия `agent-claude-code` под поддельным pty, удалённый агент - подставной `claude` под настоящим демоном и ssh -R.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { Rig } from './kit.ts';
import { lead, realize, remoteMcp, sessionsRig, until, type Mcp, type Proc, type Realized } from './tunnel-kit.ts';

interface Peer {
  id: number;
  self?: boolean;
  host?: string;
  parent?: number;
  child?: boolean;
  state: string;
  cwd: string;
}

const peersOf = async (mcp: Mcp): Promise<Peer[]> => JSON.parse((await mcp.tool('list_sessions')).text) as Peer[];

/** Локальный руководитель порождает удалённого агента и подключается к его терминалу и MCP, как это делает окно и claude на хосте. */
async function spawnRemote(r: Rig, boss: Awaited<ReturnType<typeof lead>>, branch: string) {
  assert.ok(r.repos);
  const before = r.pty.procs.length;
  const answer = await boss.mcp.tool('spawn_agent', { host: 'dev1', repo: r.repos.work.dir, branch, prompt: 'сделай задание X' });
  assert.equal(answer.isError, false, answer.text);
  const number = Number(/сессии (\d+) на dev1/.exec(answer.text)?.[1]);
  assert.ok(number > 0, answer.text);
  const proc = r.pty.procs[before] as Proc;
  assert.equal(proc.file, 'ssh');
  const term = realize(r, proc);
  await until('claude на хосте получил задание', () => term.out.text.includes('сделай задание X'));
  const sid = readdirSync(r.cyborg('sessions')).find((n) => existsSync(r.cyborg('sessions', n, 'mcp.json')));
  assert.ok(sid, 'сессия на хосте');
  const events = r.cyborg('sessions', sid, 'events.jsonl');
  // Хуки claude на хосте: подставной пишет SessionStart без номера разговора, поэтому тест дописывает его, как настоящий хук.
  await until('вкладка агента узнала начало сессии по опросу хоста', async () => {
    appendFileSync(events, `${JSON.stringify({ hook_event_name: 'SessionStart', session_id: sid })}\n`);
    return (await peersOf(boss.mcp)).find((p) => p.id === number)?.state === 'waiting';
  });
  return { number, proc, term, sid, mcp: remoteMcp(r, sid), events };
}

const delivered = (proc: Proc): string => proc.writes.join('');

describe('удалённые агенты по MCP: spawn_agent, report_done, send_to_session, close_agent', () => {
  it('spawn_agent: вкладка удалённого агента открыта дочерней руководителя, у неё host в list_sessions, клоны и задание на хосте; удалённая сессия получает свой набор инструментов', async () => {
    await using r = await sessionsRig();
    assert.ok(r.repos);
    const boss = await lead(r, r.repos.work.dir);
    // Локальной сессии проекта с хостами отдаются spawn_agent и close_agent со списком хостов проекта.
    const tools = (await boss.mcp.rpc('tools/list')).result.tools as { name: string; inputSchema: { properties: { host?: { enum: string[] } } } }[];
    assert.ok(tools.some((t) => t.name === 'close_agent'));
    assert.deepEqual(tools.find((t) => t.name === 'spawn_agent')?.inputSchema.properties.host?.enum, ['dev1']);
    const agent = await spawnRemote(r, boss, 'sp1');
    const peers = await peersOf(boss.mcp);
    const remote = peers.find((p) => p.id === agent.number);
    assert.equal(remote?.host, 'dev1');
    assert.equal(remote?.parent, boss.number);
    assert.equal(remote?.child, true);
    assert.equal(peers.find((p) => p.self)?.host, undefined, 'руководитель локальный');
    assert.ok(readFileSync(r.cyborg('sessions', agent.sid, 'meta.json'), 'utf8').includes('"origin": "tool"') || readFileSync(r.cyborg('sessions', agent.sid, 'meta.json'), 'utf8').includes('"origin":"tool"'));
    assert.deepEqual((await agent.mcp.tools()).toSorted(), ['list_sessions', 'report_done', 'send_to_session']);
    await until('клон на ветке sp1', () => readFileSync(r.cyborg('work', agent.sid, readdirSync(r.cyborg('work', agent.sid))[0] ?? '', '.git', 'HEAD'), 'utf8').includes('sp1'));
  });

  it('report_done удалённого агента приходит руководителю сообщением с хостом, отмечается на хосте, один за круг; send_to_session продолжает работу новым кругом', async () => {
    await using r = await sessionsRig();
    assert.ok(r.repos);
    const boss = await lead(r, r.repos.work.dir);
    const agent = await spawnRemote(r, boss, 'sp2');
    const answer = await agent.mcp.tool('report_done', { status: 'ok', summary: 'готово: ветка запушена', branch: 'sp2', pr: 'https://example.com/pr/1' });
    assert.equal(answer.isError, false, answer.text);
    await until('итог доставлен руководителю вставкой', () => delivered(boss.proc).includes(`Итог удалённой сессии CC${String(agent.number)} (dev1): ok`));
    assert.match(delivered(boss.proc), /ветка: sp2/);
    assert.match(delivered(boss.proc), /PR: https:\/\/example\.com\/pr\/1/);
    assert.match(delivered(boss.proc), /готово: ветка запушена/);
    await until('итог отмечен на хосте', () => /"reported":\s*true/.test(readFileSync(r.cyborg('sessions', agent.sid, 'meta.json'), 'utf8')));
    // Один итог за круг.
    const again = await agent.mcp.tool('report_done', { status: 'ok', summary: 'ещё' });
    assert.equal(again.isError, true);
    assert.match(again.text, /уже отправлен/);
    // Руководитель дописывает агенту: сообщение идёт в терминал на хосте и доходит до claude; запрос начинает новый круг.
    const sent = await boss.mcp.tool('send_to_session', { id: agent.number, message: 'продолжай, добавь тест' });
    assert.equal(sent.isError, false, sent.text);
    await until('сообщение дошло до claude на хосте', () => agent.term.out.text.includes('got: ['));
    assert.match(agent.term.out.text, /продолжай, добавь тест/);
    appendFileSync(agent.events, `${JSON.stringify({ hook_event_name: 'UserPromptSubmit' })}\n`);
    await until('новый круг: итог снова можно сдать', async () => (await agent.mcp.tool('report_done', { status: 'blocked', summary: 'нужен человек' })).isError === false);
    await until('второй итог доставлен', () => delivered(boss.proc).includes('blocked'));
  });

  it('удалённая сессия не открывает и не закрывает сессии на этой машине: open_session, close_session, spawn_agent, close_agent ей недоступны', async () => {
    await using r = await sessionsRig();
    assert.ok(r.repos);
    const boss = await lead(r, r.repos.work.dir);
    const agent = await spawnRemote(r, boss, 'sp3');
    for (const name of ['open_session', 'close_session', 'spawn_agent', 'close_agent']) {
      const res = await agent.mcp.post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name, arguments: {} } });
      assert.equal(res.json.error.code, -32602, name);
    }
  });

  it('close_agent: процесс на хосте остановлен, клоны убраны, вкладка закрыта; keep оставляет клоны', async () => {
    await using r = await sessionsRig();
    assert.ok(r.repos);
    const boss = await lead(r, r.repos.work.dir);
    const agent = await spawnRemote(r, boss, 'sp4');
    const done = await boss.mcp.tool('close_agent', { id: agent.number });
    assert.equal(done.isError, false, done.text);
    assert.match(done.text, /завершена/);
    await until('клоны на хосте убраны', () => !existsSync(r.cyborg('work', agent.sid)));
    await agent.term.closed;
    assert.equal((await peersOf(boss.mcp)).some((p) => p.id === agent.number), false, 'вкладки в проекте больше нет');
    // Локальная сессия через close_agent не закрывается.
    const wrong = await boss.mcp.tool('close_agent', { id: boss.number });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /close_session/);
    // keep: клоны остаются.
    const second = await spawnRemote(r, boss, 'sp5');
    assert.equal((await boss.mcp.tool('close_agent', { id: second.number, keep: true })).isError, false);
    await second.term.closed;
    assert.ok(existsSync(r.cyborg('work', second.sid)), 'keep оставил клоны на хосте');
  });

  it('крестик вкладки закрывает удалённую сессию на хосте и убирает клоны; обрыв ssh - нет', async () => {
    await using r = await sessionsRig();
    assert.ok(r.repos);
    const boss = await lead(r, r.repos.work.dir);
    const agent = await spawnRemote(r, boss, 'sp6');
    // Обрыв связи: ssh убит, вкладка в реестре, сессия на хосте жива.
    agent.term.child.kill('SIGKILL');
    await agent.term.closed;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(existsSync(r.cyborg('work', agent.sid)), 'обрыв клоны не трогает');
    // Второй терминал той же сессии (подхват) и крестик: человек закрыл вкладку.
    const known = new Set(((await r.kernel.run('sessions.tabs')) as { sessionId: string }[]).map((t) => t.sessionId));
    const before = r.pty.procs.length;
    await r.kernel.run('sessions.resume', { cwd: r.repos.work.dir, agent: 'remote-sessions', resumeId: agent.sid });
    const again = r.pty.procs[before] as Proc;
    const term: Realized = realize(r, again);
    await until('подхват', () => term.out.text.includes('fake-claude ready'));
    const tab = ((await r.kernel.run('sessions.tabs')) as { doc: string; sessionId: string }[]).find((t) => !known.has(t.sessionId));
    assert.ok(tab, 'вкладка подхваченной сессии');
    await r.kernel.run('sessions.close-tab', tab.doc);
    await until('клоны убраны после крестика', () => !existsSync(r.cyborg('work', agent.sid)));
  });

  it('лимит хоста: spawn_agent сверх max_agents_per_host отвергается до открытия вкладки с числом', async () => {
    await using r = await sessionsRig();
    assert.ok(r.repos);
    const boss = await lead(r, r.repos.work.dir);
    await spawnRemote(r, boss, 'sp7');
    const refused = await boss.mcp.tool('spawn_agent', { host: 'dev1', repo: r.repos.work.dir, branch: 'sp8', prompt: 'ещё', limits: { max_agents_per_host: 1 } });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /уже 1 удалённых сессий \(предел 1\)/);
    const bad = await boss.mcp.tool('spawn_agent', { host: 'evil', repo: r.repos.work.dir, branch: 'x', prompt: 'p' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /один из хостов проекта: dev1/);
    const dash = await boss.mcp.tool('spawn_agent', { host: 'dev1', repo: r.repos.work.dir, branch: '-x', prompt: 'p' });
    assert.match(dash.text, /«-»/);
  });
});
