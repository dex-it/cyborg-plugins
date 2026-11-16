import type { AgentEvent, AgentToolsEndpoint, PluginContext } from '@cyborg-harness/contracts';
import type { RemoteSessionBinding } from '@cyborg-plugins/contracts';
import { collectTools, readActions, type ToolSource } from './agent-tools.ts';
import { installAssets } from './assets.generated.ts';
import { ChildSessions } from './child-sessions.ts';
import { Delegation, type Lineage } from './delegation.ts';
import { Handoffs } from './handoff.ts';
import type { Launcher, LauncherHooks } from './launcher.ts';
import { MCP_PATH, mcpHandler, type McpBackend } from './mcp.ts';
import type { Registry, Tab } from './registry.ts';
import { Tokens } from './tokens.ts';
import { createSessionTools, OWN_TOOLS, type HandoffRequest, type Limits, type RemoteToolsPort } from './tools.ts';

// Делегирование дочерним сессиям (фича 15, M-04): MCP-сервер сессий, токены, инструменты, поручение вкладке, плагин Claude Code. Все точки подключения к главной части -
// `hooks` (для launcher), `bind` (после создания launcher), `forget` (вкладку закрыл человек) и `registerCommands`.

/** Номер версии, который сервер называет клиенту MCP. */
export const SERVER_VERSION = '1.0.0';

/** Повод для делегирования в системном промпте: порядок работы лежит в скилле, а его описание в длинном списке скиллов сессии обрезается. */
export const PARALLEL_SKILL = 'cyborg:parallel-sessions';
export const PARALLEL_PROMPT = `Cyborg ведёт работу в параллельных сессиях - локальных и удалённых, на серверах по SSH. Задачу, которая распадается на независимые части, можно делегировать другим сессиям Cyborg: в первый раз спроси человека и запомни его решение; как делегировать, вести задачу совместно, распределять нагрузку и закрывать отработавших - скилл ${PARALLEL_SKILL}.`;

/** Плагин-агент удалённых сессий: его `launch` ведёт `ssh` к демону на хосте (`remote-sessions`). */
export const REMOTE_AGENT = 'remote-sessions';

const sameDirs = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');

export interface Delegate {
  readonly hooks: LauncherHooks;
  /** Удалённая сессия `sessionId` (id запуска) привязана к вкладке: токен демона принят вместо выданного, вкладка помечена удалённой. */
  adoptRemote(sessionId: string, remote: RemoteSessionBinding): Promise<void>;
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
  /** Сессии, чьи клоны на хосте уже убраны вызовом close_agent: закрытие их вкладки хост больше не трогает. */
  const closedRemotely = new Set<string>();
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
    announce({ type: 'tabs' });
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

  // Удалённая часть - команды плагина remote-sessions (callers: plugins). Нет плагина или проекта - хостов нет, spawn_agent и close_agent не отдаются.
  const projectIdOf = async (dirs: readonly string[]): Promise<string | undefined> => {
    const projects = ctx.contracts.get('cyborg.projects', 1);
    return (await projects?.list())?.find((p) => sameDirs(p.repos, dirs))?.id;
  };
  const remoteTools: RemoteToolsPort = {
    async prepare(dirs, host, limits?: Limits) {
      const project = await projectIdOf(dirs);
      if (project === undefined) throw new Error('проект сессии не найден');
      await ctx.commands.run('remote-sessions.prepare', project, host, limits ?? {});
    },
    async report(number) {
      const found = delegation.remoteByNumber(number);
      if (found) await ctx.commands.run('remote-sessions.report', found.remote.sid);
    },
    async close(number, keep) {
      const found = delegation.remoteByNumber(number);
      if (!found) throw new Error(`сессия ${String(number)} не удалённая`);
      closedRemotely.add(found.sessionId);
      const text = String(await ctx.commands.run('remote-sessions.close', found.remote.sid, keep));
      // Сессия на хосте завершена, и `ssh` вкладки выходит вместе с ней: вкладку снимаем по id, номер к этому времени мог освободиться.
      const tab = registry.get(found.sessionId);
      if (tab) await closeTab(tab);
      return text;
    },
  };

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
      const addDirs = dirs.filter((d) => d !== request.repo);
      let opened;
      if (entry.remote) {
        // spawn_agent: клоны и демон на хосте готовит remote-sessions, вкладка подхватывает созданную сессию по её идентификатору (resumeId).
        const project = await projectIdOf(dirs);
        if (project === undefined) throw new Error('проект сессии не найден');
        const { host, branch, keep, limits } = entry.remote;
        const created = (await ctx.commands.run('remote-sessions.create-task', project, { host, repo: request.repo, branch, prompt: entry.prompt, keep, spawnedBy: request.from, ...(limits && { limits }) })) as { resumeId: string };
        opened = await launcher.open({ cwd: request.repo, addDirs, agent: REMOTE_AGENT, resumeId: created.resumeId }, { parent });
      } else opened = await launcher.open({ cwd: request.repo, addDirs, prompt: entry.prompt }, { parent });
      const number = delegation.numberOf(opened.sessionId);
      if (number === undefined) throw new Error('вкладка открыта, но уже закрыта');
      announce({ type: 'session:handoff', from: request.from, sessionId: opened.sessionId, number });
      // Вкладку открыл не вид: толчок `tabs` заставляет его перечитать вкладки (view-bridge.ts).
      announce({ type: 'tabs' });
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
      kindOf: (id) => delegation.kindOf(id),
      hostsOf: async (dirs) => {
        const project = await projectIdOf(dirs);
        if (project === undefined) return [];
        const hosts = await ctx.commands.run('remote-sessions.hosts', project);
        return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string') : [];
      },
    },
    handoffs,
    (id) => delegation.close(id),
    undefined,
    remoteTools,
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
    // Крестик вкладки (FR-17012): удалённая сессия завершается на хосте, клоны убираются; обрыв ssh сюда не приходит - вкладка остаётся в реестре.
    closed: (sessionId) => {
      const remote = delegation.remoteOf(sessionId);
      if (!remote || closedRemotely.delete(sessionId)) return;
      void Promise.resolve(ctx.commands.run('remote-sessions.close', remote.sid, false)).catch((error: unknown) => ctx.log(`удалённая сессия ${remote.sid.slice(0, 8)} на ${remote.host} не закрыта: ${String(error)}`, 'warn'));
    },
  };

  return {
    hooks,
    async adoptRemote(sessionId, remote) {
      const sid = remote.sid;
      if (typeof remote.host !== 'string' || remote.host === '' || typeof sid !== 'string' || typeof remote.token !== 'string') throw new Error('привязка удалённой сессии: нужны host, sid и token');
      if (!/^[0-9a-f-]{8,64}$/.test(sid)) throw new Error('привязка удалённой сессии: sid не годится');
      if (!tokens.adopt(sessionId, remote.token)) throw new Error('токен удалённой сессии не принят: у сессии нет выданного токена, токен не той формы или он чужой');
      delegation.setRemote(sessionId, { host: remote.host, sid });
    },
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
