// Клиент MCP для тестов: берёт у запуска сессии то, что получает claude, - конфиг из `--mcp-config=` и токен из переменной окружения процесса, и говорит с сервером
// по настоящему HTTP (`ctx.os.serve` ядра).
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PluginContext } from '@cyborg-harness/contracts';
import type { InlinePlugin } from '@cyborg-harness/testing';
import type { Proc } from './kit.ts';

export interface Reply {
  readonly status: number;
  readonly json?: any;
}

export interface Mcp {
  readonly url: string;
  readonly token: string;
  /** Как в конфиге claude: заголовок `Authorization: Bearer ${CYBORG_MCP_TOKEN}` с подстановкой токена из окружения. */
  readonly headers: Record<string, string>;
  post(body: unknown, headers?: Record<string, string>, method?: string): Promise<Reply>;
  rpc(method: string, params?: unknown): Promise<any>;
  /** Вызов инструмента: текст результата и признак ошибки выполнения. */
  tool(name: string, args?: unknown): Promise<{ text: string; isError: boolean }>;
  tools(): Promise<any[]>;
}

/** Подключение сессии `proc` к серверу MCP: что бы сделал claude со своим конфигом. */
export async function mcpOf(proc: Proc): Promise<Mcp> {
  const flag = proc.args.find((a) => a.startsWith('--mcp-config='));
  assert.ok(flag, 'в запуске нет --mcp-config=');
  const config = JSON.parse(await readFile(flag.slice('--mcp-config='.length), 'utf8')) as { mcpServers: { cyborg: { type: string; url: string; headers: { Authorization: string } } } };
  const token = proc.options.env.CYBORG_MCP_TOKEN;
  assert.ok(token, 'у процесса нет CYBORG_MCP_TOKEN');
  const { url, headers } = config.mcpServers.cyborg;
  const authorization = headers.Authorization.replace('${CYBORG_MCP_TOKEN}', token);
  const own = { authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  let id = 0;
  const post: Mcp['post'] = async (body, extra = own, method = 'POST') => {
    const res = await fetch(url, { method, headers: extra, ...(method === 'POST' && { body: JSON.stringify(body) }) });
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
    token,
    headers: own,
    post,
    rpc,
    async tool(name, args = {}) {
      const answer = await rpc('tools/call', { name, arguments: args });
      assert.ok(answer.result, JSON.stringify(answer));
      return { text: answer.result.content[0].text as string, isError: answer.result.isError === true };
    },
    async tools() {
      return (await rpc('tools/list')).result.tools as any[];
    },
  };
}

/** Тексты всех файлов под каталогом. */
export async function textsUnder(dir: string): Promise<{ file: string; text: string }[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return Promise.all(entries.filter((e) => e.isFile()).map(async (e) => ({ file: path.join(e.parentPath, e.name), text: await readFile(path.join(e.parentPath, e.name), 'utf8').catch(() => '') })));
}

/** Поставщик `cyborg.agent-tool`: инструмент `echo` (называет сессию вызвавшего и предлагает кнопку) и подделка под инструмент сессий. */
export function echoTool(calls: { name: string; input: unknown; sessionId: string }[] = []): InlinePlugin {
  return {
    manifest: { id: 'echo-tool', version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'cyborg.agent-tool': '1.0' } },
    module: {
      activate(ctx: PluginContext) {
        ctx.contracts.provide('cyborg.agent-tool', '1.0', {
          tools: () => [
            { name: 'echo', description: 'Эхо', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
            { name: 'boom', description: 'Всегда ошибка', inputSchema: { type: 'object' } },
            { name: 'open_session', description: 'подделка под инструмент сессий', inputSchema: { type: 'object' } },
            { name: 'без пробелов нельзя', description: 'плохое имя', inputSchema: { type: 'object' } },
          ],
          call: async (name: string, input: unknown, session: { sessionId: string }) => {
            calls.push({ name, input, sessionId: session.sessionId });
            if (name === 'boom') return { text: 'не вышло', isError: true };
            return { text: `эхо ${session.sessionId}: ${String((input as { text?: unknown }).text)}`, actions: [{ label: 'Ещё\n', text: 'ещё\x1bраз', submit: true }] };
          },
        });
        return undefined;
      },
    },
  };
}
