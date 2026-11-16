import type { AgentEvent, AgentToolsEndpoint, PluginContext } from '@cyborg-harness/contracts';
import { collectTools, readActions, type ToolSource } from './agent-tools.ts';
import { installAssets } from './assets.generated.ts';
import { ChildSessions } from './child-sessions.ts';
import { Delegation, type Lineage } from './delegation.ts';
import { Handoffs } from './handoff.ts';
import type { Launcher, LauncherHooks } from './launcher.ts';
import { MCP_PATH, mcpHandler, type McpBackend } from './mcp.ts';
import type { Registry, Tab } from './registry.ts';
import { Tokens } from './tokens.ts';
import { createSessionTools, OWN_TOOLS, type HandoffRequest } from './tools.ts';

// Делегирование дочерним сессиям (фича 15, M-04): MCP-сервер сессий, токены, инструменты, поручение вкладке, плагин Claude Code. Все точки подключения к главной части -
// `hooks` (для launcher), `bind` (после создания launcher), `forget` (вкладку закрыл человек) и `registerCommands`.

/** Номер версии, который сервер называет клиенту MCP. */
export const SERVER_VERSION = '1.0.0';

/** Повод для делегирования в системном промпте: порядок работы лежит в скилле, а его описание в длинном списке скиллов сессии обрезается. */
export const PARALLEL_SKILL = 'cyborg:parallel-sessions';
export const PARALLEL_PROMPT = `Cyborg ведёт работу в параллельных сессиях - локальных и удалённых, на серверах по SSH. Задачу, которая распадается на независимые части, можно делегировать другим сессиям Cyborg: в первый раз спроси человека и запомни его решение; как делегировать, вести задачу совместно, распределять нагрузку и закрывать отработавших - скилл ${PARALLEL_SKILL}.`;

export interface Delegate {
  readonly hooks: LauncherHooks;
  /** Сессия закрыта человеком или плагином: токен отозван, очередь снята. */
  forget(sessionId: string): void;
  /** Launcher создаётся с `hooks`, а поручение вкладке открывает сессии им же: связь замыкается после создания. */
  bind(launcher: Launcher): void;
  /** При активации: плагин Claude Code записан в каталог данных. */
  start(): Promise<void>;
  registerCommands(): void;
  dispose(): void;
}

export function createDelegate(ctx: PluginContext, registry: Registry): Delegate {
  const tokens = new Tokens();
  const children = new ChildSessions(`${ctx.os.paths.data}/child-sessions.json`, ctx.os.fs);
  let launcher: Launcher | undefined;

  // Вид получает сообщения, когда у плагина есть вид `main` (манифест `ui.views`); без него `post` отказывает, и это не сбой.
  const announce = (message: Record<string, unknown>): void => {
    try {
      void ctx.views.channel('main').post(message).catch(() => undefined);
    } catch {
      // вида нет
    }
  };
  const closeTab = async (tab: Tab): Promise<void> => {
    // Убрать из реестра до закрытия: выход процесса не должен считать вкладку закрытой человеком, а метки уходят вместе с ней.
    registry.remove(tab.sessionId);
    delegation.forget(tab.sessionId);
    await ctx.documents.close(tab.doc).catch((error: unknown) => ctx.log(`${tab.title}: документ не закрыт - ${String(error)}`, 'warn'));
    await tab.handle?.kill().catch(() => undefined);
  };
  const delegation: Delegation = new Delegation({
    registry,
    children,
    log: (message, level) => ctx.log(message, level),
    announce,
    closeTab,
    notify: (title, body) => {
      const notify = ctx.os.notify;
      if (!notify) {
        ctx.log(`${title}: итог некому показать (нет права notify): ${body}`, 'warn');
        return;
      }
      void notify.show(title, body).catch((error: unknown) => ctx.log(`${title}: уведомление об итоге не показано - ${String(error)}`, 'warn'));
    },
    revoke: (sessionId) => tokens.revoke(sessionId),
  });

  // Поручение вкладке: ключ одноразовый и остаётся в плагине. Открывает вкладку сам плагин (документы его), поэтому ни ключ, ни промпт до вида не доходят.
  const handoffs = new Handoffs((request: HandoffRequest) => {
    if (!launcher) return false;
    queueMicrotask(() => void fulfil(request));
    return true;
  });
  async function fulfil(request: HandoffRequest): Promise<void> {
    const entry = handoffs.take(request.hid, request.repo);
    if (!entry) return;
    try {
      const parent = delegation.sessionOf(request.from);
      const dirs = delegation.dirsOf(request.from);
      if (!launcher || parent === undefined || !dirs) throw new Error('сессия, поручившая работу, завершилась');
      const opened = await launcher.open({ cwd: request.repo, addDirs: dirs.filter((d) => d !== request.repo), prompt: entry.prompt }, { parent });
      const number = delegation.numberOf(opened.sessionId);
      if (number === undefined) throw new Error('вкладка открыта, но уже закрыта');
      announce({ type: 'session:handoff', from: request.from, sessionId: opened.sessionId, number });
      entry.resolve(number);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.log(`поручение CC${String(request.from)}: ${reason}`, 'warn');
      entry.reject(new Error(reason.slice(0, 500)));
    }
  }

  const own: McpBackend = createSessionTools(
    {
      dirsOf: (id) => delegation.dirsOf(id),
      peers: (id) => delegation.peers(id),
      say: (id, text) => delegation.say(id, text),
      isChild: (id) => delegation.isChild(id),
      reportLocal: (id, report) => delegation.reportLocal(id, report),
    },
    handoffs,
    (id) => delegation.close(id),
  );

  // Инструменты поставщиков идут вслед за своими; своя сессия вызывает только то, что видит в tools/list.
  const sources = (): ToolSource[] => ctx.contracts.all('cyborg.agent-tool', 1);
  const backend: McpBackend = {
    async tools(caller) {
      const mine = await own.tools(caller);
      // Сессии нет (вышла, токен ещё жив до отзыва) - никаких инструментов.
      if (mine.length === 0) return [];
      const vendors = await collectTools(sources(), OWN_TOOLS, (m) => ctx.log(m));
      return [...mine, ...[...vendors.values()].map(({ spec }) => ({ name: spec.name, description: spec.description, inputSchema: spec.inputSchema }))];
    },
    async call(caller, name, value) {
      if (OWN_TOOLS.includes(name)) return own.call(caller, name, value);
      const sessionId = delegation.sessionOf(caller);
      if (sessionId === undefined) throw new Error('сессия завершена');
      const tool = (await collectTools(sources(), OWN_TOOLS, (m) => ctx.log(m))).get(name);
      if (!tool) throw new Error(`инструмента ${name} нет`);
      const answer = await tool.source.impl.call(name, value, { sessionId });
      const actions = readActions(answer.actions);
      if (actions.length > 0) delegation.setActions(sessionId, actions);
      // Ошибка инструмента - ответ агенту, а не сбой протокола: так её видит модель и может поправить вызов.
      if (answer.isError === true) throw new Error(answer.text);
      return answer.text;
    },
  };

  // Сервер один на плагин и поднимается с первой сессией; порт выбирает ОС, поэтому после перезапуска хоста плагина оставленные сессии свой сервер не находят (README).
  let server: Promise<string> | undefined;
  const mcpUrl = (): Promise<string | undefined> => {
    const serve = ctx.os.serve;
    if (!serve) return Promise.resolve(undefined);
    server ??= serve
      .http(
        mcpHandler({
          callerOf: (token) => {
            const sessionId = tokens.sessionOf(token);
            return sessionId === undefined ? undefined : delegation.numberOf(sessionId);
          },
          backend,
          version: SERVER_VERSION,
        }),
      )
      .then((s) => `${s.url}${MCP_PATH}`);
    return server.catch((error: unknown) => {
      server = undefined;
      ctx.log(`сервер MCP не поднялся: ${String(error)}`, 'warn');
      return undefined;
    });
  };

  // Плагин Claude Code (скилл и хук): ресурсы вшиты в index.mjs и записываются в каталог данных при активации; ошибка записи сессии не мешает.
  let pluginDir: Promise<string | undefined> | undefined;
  const assets = (): Promise<string | undefined> => (pluginDir ??= installAssets(ctx.os).catch((error: unknown) => {
    ctx.log(`плагин Claude Code не записан, сессии идут без его скилла: ${String(error)}`, 'warn');
    return undefined;
  }));

  const hooks: LauncherHooks = {
    async prepare(sessionId) {
      const url = await mcpUrl();
      const dir = await assets();
      let tools: AgentToolsEndpoint | undefined;
      if (url !== undefined) tools = { url, token: tokens.issue(sessionId) };
      return {
        ...(tools && { tools }),
        // Повод для делегирования - только когда есть и инструменты, и скилл, на который он ссылается.
        fragments: tools && dir !== undefined ? [PARALLEL_PROMPT] : [],
        args: dir !== undefined ? [`--plugin-dir=${dir}`] : [],
      };
    },
    lineageOf: (parent) => delegation.lineageOf(parent),
    attach: (tab, lineage: Lineage, adopted) => void delegation.attach(tab, lineage, adopted),
    event: (tab: Tab, e: AgentEvent) => delegation.event(tab, e),
    ended: (sessionId) => delegation.forget(sessionId),
  };

  return {
    hooks,
    forget: (sessionId) => delegation.forget(sessionId),
    bind: (l) => void (launcher = l),
    start: async () => void (await assets()),
    registerCommands() {
      // Данные для вида: номер и подпись `CC<n> ↳<родитель>`, семья (цвет у всей семьи один; рисует вид).
      ctx.commands.register('sessions.family', () => delegation.family());
      // Номера разговоров Claude Code, открытых другой сессией: «История» помечает их как дочерние.
      ctx.commands.register('sessions.children', async () => [...(await children.all())]);
      // Кнопки, которые предложили инструменты поставщиков; вид спрашивает их при открытии, дальше следит за сообщениями.
      ctx.commands.register('sessions.actions', (sessionId) => (typeof sessionId === 'string' ? delegation.actionsOf(sessionId) : []));
    },
    dispose: () => delegation.dispose(),
  };
}
