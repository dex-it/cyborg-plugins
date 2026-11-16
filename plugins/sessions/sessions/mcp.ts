import type { ServeRequest, ServeResponse } from '@cyborg-harness/contracts';

// Сервер MCP сессий: JSON-RPC в POST /mcp без потока SSE (FR-15002). Перенос src/main/mcp.ts ai-cyborg на право `serve` ядра:
// сокет, чужой Host и Origin страницы браузера (403) ядро отсекает само, здесь остаются путь, токен сессии (401), метод (405), размер и разбор тела.
// Порт на 127.0.0.1 виден всем пользователям машины: вызывающую сессию называет только её токен (NFR-15001).

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface McpBackend {
  /** Инструменты зависят от вызывающей сессии: схема несёт её каталоги. */
  tools(caller: number): McpTool[] | Promise<McpTool[]>;
  /** Текст результата; исключение - ошибка выполнения инструмента (isError), её текст видит модель. */
  call(caller: number, name: string, args: unknown): Promise<string>;
}

export const SERVER_NAME = 'cyborg';
export const MCP_PATH = '/mcp';

// Клиенту отвечаем его же версией, если она известна: клиент SDK отвергает версию вне своего списка.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Тексты инструментов ограничены 100 КБ (tools.ts), остальное - конверт JSON-RPC с запасом. Ядро принимает тело до 1 МиБ само. */
export const MAX_BODY_BYTES = 1024 * 1024;

type RpcId = string | number;
export type RpcReply = { jsonrpc: '2.0'; id: RpcId | null } & ({ result: unknown } | { error: { code: number; message: string } });

const reply = (id: RpcId | null, result: unknown): RpcReply => ({ jsonrpc: '2.0', id, result });
const failure = (id: RpcId | null, code: number, message: string): RpcReply => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Одно сообщение JSON-RPC. null - ответа нет: уведомление либо ответ клиента. */
export async function handleRpc(message: unknown, caller: number, backend: McpBackend, version: string): Promise<RpcReply | null> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return failure(null, -32600, 'Invalid Request');
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  const hasId = typeof id === 'string' || typeof id === 'number';
  if (typeof method !== 'string') return hasId ? null : failure(null, -32600, 'Invalid Request');
  if (!hasId) return null;
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
  switch (method) {
    case 'initialize': {
      const asked = typeof p.protocolVersion === 'string' && PROTOCOL_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOL_VERSIONS[0];
      return reply(id, { protocolVersion: asked, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version } });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: await backend.tools(caller) });
    case 'tools/call': {
      if (typeof p.name !== 'string' || !(await backend.tools(caller)).some((t) => t.name === p.name)) return failure(id, -32602, `Unknown tool: ${String(p.name)}`);
      try {
        const text = await backend.call(caller, p.name, p.arguments ?? {});
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (error) {
        return reply(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

const json = (status: number, body: unknown): ServeResponse => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export interface McpHandlerOptions {
  /** Сессия по токену из `Authorization: Bearer`; токен неизвестен или отозван - `undefined`. */
  callerOf(token: string): number | undefined;
  backend: McpBackend;
  version: string;
}

/** Обработчик `ctx.os.serve.http`: один запрос - один ответ JSON, потока SSE нет. */
export function mcpHandler(options: McpHandlerOptions): (request: ServeRequest) => Promise<ServeResponse> {
  return async (request) => {
    if (request.path.split('?')[0] !== MCP_PATH) return { status: 404 };
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    const caller = token === undefined ? undefined : options.callerOf(token);
    if (caller === undefined) return { status: 401 };
    // Потока SSE сервер не держит: запросов клиенту он не шлёт, и GET по спецификации получает 405.
    if (request.method !== 'POST') return { status: 405, headers: { allow: 'POST' } };
    if (request.body.length > MAX_BODY_BYTES) return { status: 413 };
    let message: unknown;
    try {
      message = JSON.parse(request.body);
    } catch {
      return json(400, failure(null, -32700, 'Parse error'));
    }
    const answer = await handleRpc(message, caller, options.backend, options.version);
    if (!answer) return { status: 202 };
    return json('error' in answer && answer.id === null ? 400 : 200, answer);
  };
}
