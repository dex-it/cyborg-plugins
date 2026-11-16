// cyborg.sessions 1.3: `adoptRemote` (M-05, решение 13). Токен удалённой сессии выбирает демон на хосте, `sessions` принимает его вместо выданного и помечает вкладку удалённой.
// Тест на настоящем ядре и настоящем HTTP: сессия открыта локальным агентом, привязку к хосту делает «поставщик агента» (здесь - проба).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionsV13 } from '@cyborg-plugins/contracts';
import type { Remote } from '@cyborg-harness/contracts';
import { rig, until, type Rig } from './kit.ts';
import { mcpOf, type Mcp } from './mcp-kit.ts';

const TOKEN = 'R'.repeat(43);
const SID = '0123456789abcdef0123456789abcdef'.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

const adopt = (r: Rig): Remote<SessionsV13>['adoptRemote'] => (r.probe.contracts.get('cyborg.sessions', 1) as Remote<SessionsV13>).adoptRemote;

async function rawCall(mcp: Mcp, token: string, method: string, params: unknown = {}): Promise<{ status: number; json?: any }> {
  const res = await fetch(mcp.url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await res.text();
  return { status: res.status, ...(text !== '' && { json: JSON.parse(text) }) };
}

test('adoptRemote: токен демона принят вместо выданного, вкладка помечена удалённой: свой набор инструментов и host в list_sessions', async () => {
  await using r = await rig();
  const { sessionId } = await r.sessions.create({ cwd: r.repoA });
  const proc = r.last();
  await r.armed(proc);
  const mcp = await mcpOf(proc);
  const before = (await mcp.tools()).map((t) => t.name).toSorted();
  assert.ok(before.includes('open_session') && before.includes('close_session'), 'до привязки сессия локальная');

  await adopt(r)(sessionId, { host: 'dev1', sid: SID, token: TOKEN });
  assert.equal((await rawCall(mcp, mcp.token, 'tools/list')).status, 401, 'выданный токен отозван');
  const tools = ((await rawCall(mcp, TOKEN, 'tools/list')).json.result.tools as { name: string }[]).map((t) => t.name).toSorted();
  assert.deepEqual(tools, ['list_sessions', 'report_done', 'send_to_session'], 'открывать и закрывать сессии на этой машине удалённая не может');
  const list = JSON.parse((await rawCall(mcp, TOKEN, 'tools/call', { name: 'list_sessions', arguments: {} })).json.result.content[0].text) as { self?: boolean; host?: string }[];
  assert.equal(list.find((p) => p.self)?.host, 'dev1');
  const refused = await rawCall(mcp, TOKEN, 'tools/call', { name: 'open_session', arguments: { repo: r.repoA, prompt: 'p' } });
  assert.equal(refused.json.error.code, -32602);
});

test('adoptRemote отказывает: сессии нет, токен чужой формы, чужой токен, негодные host и sid; токен принятой сессии отзывается её выходом', async () => {
  await using r = await rig();
  const first = await r.sessions.create({ cwd: r.repoA });
  const procA = r.last();
  const second = await r.sessions.create({ cwd: r.repoB });
  const procB = r.last();
  const call = adopt(r);
  await assert.rejects(call('s-net', { host: 'dev1', sid: SID, token: TOKEN }), /не принят/);
  await assert.rejects(call(first.sessionId, { host: 'dev1', sid: SID, token: 'короткий' }), /не принят/);
  await assert.rejects(call(first.sessionId, { host: '', sid: SID, token: TOKEN }), /нужны host, sid и token/);
  await assert.rejects(call(first.sessionId, { host: 'dev1', sid: '../x', token: TOKEN }), /sid не годится/);
  await call(first.sessionId, { host: 'dev1', sid: SID, token: TOKEN });
  await assert.rejects(call(second.sessionId, { host: 'dev2', sid: SID, token: TOKEN }), /не принят/, 'один токен - одна сессия');
  assert.notEqual(procA, procB);
  const mcp = await mcpOf(procB);
  assert.equal((await rawCall(mcp, TOKEN, 'tools/list')).status, 200);
  procA.exit(0);
  await until('выход сессии отозвал принятый токен', async () => (await rawCall(mcp, TOKEN, 'tools/list')).status === 401);
  assert.equal((await rawCall(mcp, mcp.token, 'tools/list')).status, 200, 'токен второй сессии цел');
});
