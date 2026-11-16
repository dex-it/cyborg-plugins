// Перенос test/mcp.test.ts ai-cyborg (FR-15002, NFR-15001): протокол JSON-RPC и вход сервера. Утверждения те же; `McpServer` на сокете заменён обработчиком
// `ctx.os.serve.http` (сокет, Host и Origin ядро держит само: их проверяет mcp-server.test.ts на настоящем ядре), токены - классом `Tokens`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ServeRequest } from '@cyborg-harness/contracts';
import { handleRpc, MAX_BODY_BYTES, mcpHandler, type McpBackend } from '../mcp.ts';
import { Tokens } from '../tokens.ts';
import { sessionTools, validateOpenSession } from '../tools.ts';

const DIRS = ['/repo/a', '/repo/b'];

const backend: McpBackend = {
  tools: (caller) => (caller === 1 ? sessionTools(DIRS) : []),
  call: async (caller, _name, args) => {
    const valid = validateOpenSession(args, DIRS);
    if (typeof valid === 'string') throw new Error(valid);
    return `${caller}:${valid.repo}`;
  },
};

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('handleRpc', () => {
  it('initialize отвечает версией клиента, неизвестной - последней своей; инструменты объявлены', async () => {
    const known = (await handleRpc(rpc('initialize', { protocolVersion: '2025-06-18' }), 1, backend, '0.1.0')) as any;
    assert.equal(known.result.protocolVersion, '2025-06-18');
    assert.deepEqual(known.result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(known.result.serverInfo, { name: 'cyborg', version: '0.1.0' });
    const unknown = (await handleRpc(rpc('initialize', { protocolVersion: '1999-01-01' }), 1, backend, '0.1.0')) as any;
    assert.equal(unknown.result.protocolVersion, '2025-11-25');
  });

  it('уведомления и ответы клиента остаются без ответа', async () => {
    assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, 1, backend, 'v'), null);
    assert.equal(await handleRpc({ jsonrpc: '2.0', id: 5, result: {} }, 1, backend, 'v'), null);
  });

  it('tools/list отдаёт инструменты вызывающей сессии с её каталогами в схеме', async () => {
    const list = (await handleRpc(rpc('tools/list'), 1, backend, 'v')) as any;
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ['open_session', 'list_sessions', 'send_to_session', 'close_session']);
    assert.deepEqual(list.result.tools[0].inputSchema.properties.repo.enum, DIRS);
    assert.deepEqual(((await handleRpc(rpc('tools/list'), 2, backend, 'v')) as any).result.tools, []);
  });

  it('tools/call: результат текстом, ошибка выполнения - isError с причиной, чужой инструмент - ошибка протокола', async () => {
    const ok = (await handleRpc(rpc('tools/call', { name: 'open_session', arguments: { prompt: 'сделай', repo: '/repo/b' } }), 1, backend, 'v')) as any;
    assert.deepEqual(ok.result, { content: [{ type: 'text', text: '1:/repo/b' }] });
    const bad = (await handleRpc(rpc('tools/call', { name: 'open_session', arguments: { prompt: 'сделай', repo: '/etc' } }), 1, backend, 'v')) as any;
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /\/repo\/a, \/repo\/b/);
    const foreign = (await handleRpc(rpc('tools/call', { name: 'open_session', arguments: {} }), 2, backend, 'v')) as any;
    assert.equal(foreign.error.code, -32602);
  });

  it('неизвестный метод - -32601, не объект - -32600', async () => {
    assert.equal(((await handleRpc(rpc('resources/list'), 1, backend, 'v')) as any).error.code, -32601);
    for (const junk of [null, 1, 'x', [rpc('ping')]]) assert.equal(((await handleRpc(junk, 1, backend, 'v')) as any).error.code, -32600);
    assert.deepEqual(((await handleRpc(rpc('ping'), 1, backend, 'v')) as any).result, {});
  });
});

describe('mcpHandler', () => {
  function started() {
    const tokens = new Tokens();
    const handler = mcpHandler({ callerOf: (token) => (tokens.sessionOf(token) === 's1' ? 1 : undefined), backend, version: 'v' });
    const token = tokens.issue('s1');
    const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${token}` }, method = 'POST', path = '/mcp'): Promise<{ status: number; headers?: Readonly<Record<string, string>>; body?: string }> =>
      handler({ method, path, headers, body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body) } satisfies ServeRequest);
    return { tokens, token, post };
  }

  it('по токену отвечает за его сессию: JSON, инструменты сессии, уведомление - 202', async () => {
    const { post } = started();
    const res = await post(rpc('tools/list'));
    assert.equal(res.status, 200);
    assert.match(res.headers?.['content-type'] ?? '', /application\/json/);
    assert.equal(JSON.parse(res.body ?? '').result.tools[0].name, 'open_session');
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.equal((await post(rpc('tools/list'), { authorization: 'Bearer ' + 'x'.repeat(5) })).status, 401);
  });

  it('без токена, с чужим токеном и после отзыва - 401', async () => {
    const { tokens, post } = started();
    assert.equal((await post(rpc('tools/list'), {})).status, 401);
    assert.equal((await post(rpc('tools/list'), { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await post(rpc('tools/list'), { authorization: 'Basic abc' })).status, 401);
    tokens.revoke('s1');
    assert.equal((await post(rpc('tools/list'))).status, 401);
  });

  it('GET - 405, чужой путь - 404, не JSON - 400, тело больше предела - 413', async () => {
    const { post } = started();
    const get = await post(undefined, undefined, 'GET');
    assert.equal(get.status, 405);
    assert.equal(get.headers?.allow, 'POST');
    assert.equal((await post('{}', undefined, 'POST', '/other')).status, 404);
    assert.equal((await post(rpc('ping'), undefined, 'POST', '/mcp?x=1')).status, 200, 'запрос в пути не мешает');
    const broken = await post('{не json');
    assert.equal(broken.status, 400);
    assert.equal(JSON.parse(broken.body ?? '').error.code, -32700);
    assert.equal((await post('x'.repeat(MAX_BODY_BYTES + 1))).status, 413);
  });
});

describe('Tokens', () => {
  it('токен у каждой сессии свой и случайный: 43 знака base64url; повторный выпуск отзывает прежний', () => {
    const tokens = new Tokens();
    const a = tokens.issue('a');
    const b = tokens.issue('b');
    assert.match(a, /^[\w-]{43}$/);
    assert.notEqual(a, b);
    assert.equal(tokens.sessionOf(a), 'a');
    const again = tokens.issue('a');
    assert.equal(tokens.sessionOf(a), undefined);
    assert.equal(tokens.sessionOf(again), 'a');
    assert.equal(tokens.size, 2);
    tokens.revoke('a');
    tokens.revoke('a');
    assert.equal(tokens.sessionOf(again), undefined);
    assert.equal(tokens.sessionOf(b), 'b');
  });
});
