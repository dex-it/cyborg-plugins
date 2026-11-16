// Сценарии туннеля MCP и инструментов удалённых агентов (S19/S21 на подставном хосте): настоящие `sessions` (сервер MCP), `agent-claude-code` (локальный руководитель),
// `remote-sessions` и настоящий демон; подставные `ssh`, `claude`, `script`. Терминалы сессий - `fakePty()` ядра, но запуск `ssh` исполняется по-настоящему:
// `realize` запускает ту же программу с теми же аргументами и связывает её ввод и вывод с поддельным pty, как сделал бы node-pty.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { FakePty } from '@cyborg-harness/testing';
import { rig, until, type Rig } from './kit.ts';

export { until };
export type Proc = FakePty['procs'][number];

export interface Mcp {
  readonly url: string;
  post(body: unknown, headers?: Record<string, string>): Promise<{ status: number; json?: any }>;
  rpc(method: string, params?: unknown): Promise<any>;
  tool(name: string, args?: unknown): Promise<{ text: string; isError: boolean }>;
  tools(): Promise<string[]>;
}

/** Клиент MCP с адресом и токеном: что делает claude со своим конфигом. */
export function mcpAt(url: string, authorization: string): Mcp {
  const headers = { authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  let id = 0;
  const post: Mcp['post'] = async (body, extra = headers) => {
    const res = await fetch(url, { method: 'POST', headers: extra, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, ...(text !== '' && { json: JSON.parse(text) }) };
  };
  const rpc: Mcp['rpc'] = async (method, params) => {
    const res = await post({ jsonrpc: '2.0', id: ++id, method, params });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json;
  };
  return {
    url,
    post,
    rpc,
    async tool(name, args = {}) {
      const answer = await rpc('tools/call', { name, arguments: args });
      assert.ok(answer.result, JSON.stringify(answer));
      return { text: answer.result.content[0].text as string, isError: answer.result.isError === true };
    },
    async tools() {
      return ((await rpc('tools/list')).result.tools as { name: string }[]).map((t) => t.name);
    },
  };
}

/** Локальная сессия: конфиг из `--mcp-config=` и токен из окружения процесса. */
export function localMcp(proc: Proc): Mcp {
  const flag = proc.args.find((a) => a.startsWith('--mcp-config='));
  assert.ok(flag, 'в запуске нет --mcp-config=');
  const config = JSON.parse(readFileSync(flag.slice('--mcp-config='.length), 'utf8')) as { mcpServers: { cyborg: { url: string; headers: { Authorization: string } } } };
  const token = proc.options.env.CYBORG_MCP_TOKEN;
  assert.ok(token, 'у процесса нет CYBORG_MCP_TOKEN');
  return mcpAt(config.mcpServers.cyborg.url, config.mcpServers.cyborg.headers.Authorization.replace('${CYBORG_MCP_TOKEN}', token));
}

/** Удалённая сессия: конфиг, который демон записал на хосте (mcp.json 0600), - адрес прокси демона и токен демона. */
export function remoteMcp(r: Rig, sid: string): Mcp {
  const file = r.cyborg('sessions', sid, 'mcp.json');
  const config = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: { cyborg: { url: string; headers: { Authorization: string } } } };
  return mcpAt(config.mcpServers.cyborg.url, config.mcpServers.cyborg.headers.Authorization);
}

export interface Realized {
  readonly child: ChildProcess;
  readonly out: { text: string };
  closed: Promise<void>;
}

/** Исполняет запуск из поддельного pty настоящим процессом: ввод `proc.write` идёт в stdin, вывод - в `proc.emit`, выход - в `proc.exit`. */
export function realize(r: Rig, proc: Proc): Realized {
  const child = spawn(proc.file, proc.args, { env: { ...r.box.env, ...proc.options.env }, stdio: 'pipe' });
  const out = { text: '' };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    out.text += d;
    proc.emit(d);
  });
  (proc as { write: (d: string) => void }).write = (d) => void child.stdin.write(d);
  (proc as { kill: (s?: string) => void }).kill = () => void child.kill('SIGKILL');
  const closed = new Promise<void>((resolve) =>
    child.on('close', (code) => {
      proc.exit(code ?? 1);
      resolve();
    }),
  );
  return { child, out, closed };
}

/** Хук Claude Code локального руководителя: строка JSON в файл событий его процесса. */
export const hook = (proc: Proc, record: object): void => appendFileSync(proc.options.env.CYBORG_EVENTS ?? '', `${JSON.stringify(record)}\n`);

/** Локальный руководитель: сессия `sessions` в репозитории проекта, готовая принимать сообщения (состояние waiting) и звать инструменты. */
export async function lead(r: Rig, cwd: string): Promise<{ proc: Proc; mcp: Mcp; sessionId: string; number: number }> {
  const before = r.pty.procs.length;
  const opened = (await r.kernel.run('sessions.create', { cwd })) as { sessionId: string };
  const proc = r.pty.procs[before];
  assert.ok(proc && proc.file !== 'ssh', 'локальная сессия не запущена');
  const mcp = localMcp(proc);
  // Хуки читаются после взвода слежения: пробная строка повторяется, пока сессия не стала waiting.
  await until('руководитель ждёт сообщения', async () => {
    hook(proc, { hook_event_name: 'SessionStart', session_id: 'lead-1', cwd });
    const peers = JSON.parse((await mcp.tool('list_sessions')).text) as { self?: boolean; state: string }[];
    return peers.find((p) => p.self)?.state === 'waiting';
  });
  const peers = JSON.parse((await mcp.tool('list_sessions')).text) as { id: number; self?: boolean }[];
  return { proc, mcp, sessionId: opened.sessionId, number: peers.find((p) => p.self)?.id ?? 0 };
}

export const sessionsRig = (options: { hosts?: string[] } = {}): Promise<Rig> => rig({ repos: true, withSessions: true, ...options });

export const fileExists = existsSync;
