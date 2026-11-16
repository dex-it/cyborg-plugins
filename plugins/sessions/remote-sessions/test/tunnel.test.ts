// Туннель MCP к удалённому хосту (FR-17007) на настоящих `sessions`, `remote-sessions` и демоне: подставной хост - эта же машина, `ssh -R` настоящий (фикстура).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CLAUDE_TOKEN, manifest } from './kit.ts';
import { fileExists, mcpAt, realize, remoteMcp, sessionsRig, until } from './tunnel-kit.ts';

interface Info {
  resumeId: string;
  sid: string;
  cwd: string;
}

describe('туннель MCP: сессия на хосте ходит к серверу sessions под токеном демона', () => {
  it('запуск через sessions: ssh -R с сокетом хоста и портом сервера, токен демона принят вместо выданного; агент на хосте зовёт инструменты удалённой сессии', async () => {
    await using r = await sessionsRig();
    assert.ok(r.repos);
    const cwd = r.repos.work.dir;
    const info = (await r.call('remote-sessions.create', 'p1', { host: 'dev1', repo: cwd, branch: 'tn1' })) as Info;
    await until('claude на хосте запущен демоном', () => fileExists(r.cyborg('sessions', info.sid, 'mcp.json')));
    const before = r.pty.procs.length;
    await r.kernel.run('sessions.resume', { cwd, agent: 'remote-sessions', resumeId: info.resumeId });
    const proc = r.pty.procs[before];
    assert.ok(proc);
    assert.equal(proc.file, 'ssh');
    // Закреплённая приставка правила, затем описание туннеля, «--», хост и команда с сокетом хоста.
    const rule = manifest.permissions.launch[1];
    assert.deepEqual(proc.args.slice(0, rule?.args.length), rule?.args);
    const [spec, dd, host, command] = proc.args.slice(rule?.args.length ?? 0);
    assert.match(spec ?? '', /^\/.+\/\.cyborg\/run\/mcp-[0-9a-f]{16}\.sock:127\.0\.0\.1:\d+$/);
    assert.equal(dd, '--');
    assert.equal(host, 'dev1');
    assert.match(command ?? '', /client\.sh attach [0-9a-f-]{36} [0-9a-f-]{36} --fwd=\/.+\/fwd-([0-9a-f]{16})\.sock --upstream=\/.+\/mcp-\1\.sock --mcp-port=\d+$/);
    // Токена MCP нет ни в аргументах, ни в окружении ssh: он остаётся в памяти сервера, на хосте в mcp.json 0600 и в окружении claude.
    const config = JSON.parse(readFileSync(r.cyborg('sessions', info.sid, 'mcp.json'), 'utf8')) as { mcpServers: { cyborg: { headers: { Authorization: string } } } };
    const token = config.mcpServers.cyborg.headers.Authorization.replace('Bearer ', '');
    assert.equal(JSON.stringify(proc.args).includes(token), false);
    assert.equal(JSON.stringify(proc.options.env).includes(token), false);
    assert.equal(proc.options.env.CYBORG_MCP_TOKEN, undefined, 'выданный sessions токен до ssh не доходит');
    assert.equal(JSON.stringify(r.sshLog()).includes(token), false);

    const term = realize(r, proc);
    await until('терминал сессии на хосте', () => term.out.text.includes('fake-claude ready'));
    const mcp = remoteMcp(r, info.sid);
    await until('сервер sessions отвечает по туннелю', async () => {
      try {
        return (await mcp.tools()).length > 0;
      } catch {
        return false;
      }
    });
    // У удалённой сессии свой набор: список, сообщение, итог; открывать и закрывать сессии на этой машине она не может.
    assert.deepEqual((await mcp.tools()).toSorted(), ['list_sessions', 'report_done', 'send_to_session']);
    const call = await mcp.post({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'open_session', arguments: { repo: cwd, prompt: 'вылезти на машину человека' } } });
    assert.equal(call.json.error.code, -32602, 'open_session удалённой сессии неизвестен');
    // Чужой токен и токен без привязки сервер не принимает.
    const stranger = mcpAt(mcp.url, `Bearer ${'A'.repeat(43)}`);
    assert.equal((await stranger.post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
    // Токен принят вместо выданного: выданный отозван, а у вкладки есть host в list_sessions.
    const peers = JSON.parse((await mcp.tool('list_sessions')).text) as { self?: boolean; host?: string; state: string }[];
    assert.equal(peers.find((p) => p.self)?.host, 'dev1');
    term.child.kill('SIGKILL');
    await term.closed;
    assert.equal(existsSync(r.cyborg('sessions', info.sid, 'meta.json')), true, 'обрыв ssh сессию на хосте не закрывает');
  });

  it('токен Claude, токены gh и glab и токен MCP не попадают в журнал ядра, config, state и аргументы ssh', async () => {
    await using r = await sessionsRig();
    assert.ok(r.repos);
    const cwd = r.repos.work.dir;
    const info = (await r.call('remote-sessions.create', 'p1', { host: 'dev1', repo: cwd, branch: 'tn2' })) as Info;
    await until('mcp.json', () => fileExists(r.cyborg('sessions', info.sid, 'mcp.json')));
    const token = (JSON.parse(readFileSync(r.cyborg('sessions', info.sid, 'mcp.json'), 'utf8')) as { mcpServers: { cyborg: { headers: { Authorization: string } } } }).mcpServers.cyborg.headers.Authorization.replace('Bearer ', '');
    await r.kernel.run('sessions.resume', { cwd, agent: 'remote-sessions', resumeId: info.resumeId });
    const everywhere = JSON.stringify([r.kernel.journal, [...r.config.docs.entries()], [...r.state.docs.entries()], r.sshLog(), r.pty.procs.map((p) => [p.file, p.args, p.options])]);
    assert.equal(everywhere.includes(token), false, 'токен MCP');
    assert.equal(everywhere.includes(CLAUDE_TOKEN), false, 'токен Claude');
  });
});
