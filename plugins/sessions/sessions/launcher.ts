import type { Agent, AgentEvent, AgentFacts, AgentToolsEndpoint, DocumentInfo, LaunchSpec, OsPty, PluginContext, Provider, PtyHandle, Remote } from '@cyborg-harness/contracts';
import { validateCreateInput, type CreateInput } from './args.ts';
import { describe, sessionChange } from './events.ts';
import { collectFragments } from './prompt.ts';
import type { Registry, Tab } from './registry.ts';
import type { Lineage } from './delegation.ts';
import type { SessionLabelsPatch } from '@cyborg-plugins/contracts';

// Жизненный цикл сессии: открыть (проверка каталогов, выбор агента, запуск в pty потребителя), следить за событиями агента и выходом процесса,
// подхватить оставленные pty после перезапуска хоста, восстановить вышедшую сессию вручную. Источник: src/main/sessions.ts (create, onExit),
// пилот ядра playground/plugins/sessions.

const COLS = 120;
const ROWS = 40;
/** Факты агента (`claude --version` через оболочку входа) - лишний процесс на каждый запуск; найденный агент меняется редко. */
const FACTS_TTL_MS = 60_000;

type AgentProvider = Provider<Remote<Agent>>;

/** Результат открытия: сессия и билет терминала для вида (`ctx.terminal.open` во фрейме). */
export interface Opened {
  readonly sessionId: string;
  readonly title: string;
  readonly ticket: string;
}

/**
 * Данные документа вкладки: с ними сессия возвращается после перезапуска. `pty` («id:pid») по документу находит оставленный процесс при активации:
 * id в таблице ядра считает с нуля при каждом запуске приложения, и без pid документ прошлого запуска мог бы подхватить чужой процесс с тем же id.
 * Меток, промпта и вывода здесь нет: привязка задачи и MR - только память (FR-1015, FR-2014).
 */
interface Saved {
  readonly agent: string;
  readonly sessionId: string;
  readonly pty: string;
  readonly cwd: string;
  readonly addDirs: readonly string[];
  readonly resumeId?: string;
  /** Кто открыл сессию и к какой семье она относится: метка и цвет вкладки (рисует вид). */
  readonly lineage: Lineage;
}

/** Точки подключения делегирования (delegate.ts): сессия получает MCP-инструменты, плагин Claude Code и учёт состояния. Без него launcher работает как до M-04. */
export interface LauncherHooks {
  /** Перед запуском: токен и адрес сервера MCP, дополнения к промпту и аргументы запуска (ключ плагина Claude Code). */
  prepare(sessionId: string): Promise<{ tools?: AgentToolsEndpoint; fragments: readonly string[]; args: readonly string[] }>;
  lineageOf(parent: string | undefined): Lineage;
  /** Вкладка добавлена в реестр. */
  attach(tab: Tab, lineage: Lineage, adopted: boolean): void;
  /** Событие агента сессии. */
  event(tab: Tab, e: AgentEvent): void;
  /** Процесс вышел либо запуск не удался: токен отозван, очередь снята. */
  ended(sessionId: string): void;
  /** Вкладку закрыл человек или инструмент: процесс завершён после того, как вкладку убрали из реестра (до `ended`). */
  closed?(sessionId: string): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const field = (data: unknown, key: string): string | undefined => {
  const value = isRecord(data) ? data[key] : undefined;
  return typeof value === 'string' ? value : undefined;
};
const strings = (data: unknown, key: string): string[] => {
  const value = isRecord(data) ? data[key] : undefined;
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
};

const dataOf = (saved: Saved) => ({
  agent: saved.agent,
  sessionId: saved.sessionId,
  pty: saved.pty,
  cwd: saved.cwd,
  addDirs: [...saved.addDirs],
  ...(saved.resumeId !== undefined && { resumeId: saved.resumeId }),
  ...(saved.lineage.parent !== undefined && { parent: saved.lineage.parent }),
  ...(saved.lineage.parentNumber !== undefined && { parentNumber: saved.lineage.parentNumber }),
  ...(saved.lineage.family !== undefined && { family: saved.lineage.family }),
});
/** Родитель и семья из документа вкладки. */
const lineageIn = (data: unknown): Lineage => {
  const parent = field(data, 'parent');
  const family = field(data, 'family');
  const number = isRecord(data) && typeof data.parentNumber === 'number' && Number.isInteger(data.parentNumber) ? data.parentNumber : undefined;
  return { ...(parent !== undefined && { parent }), ...(number !== undefined && { parentNumber: number }), ...(family !== undefined && { family }) };
};
const byId = (a: { pluginId: string }, b: { pluginId: string }): number => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0);

export interface Launcher {
  /** Поставщики `cyborg.agent` по порядку id. */
  agents(): AgentProvider[];
  open(input: CreateInput, options?: { labels?: SessionLabelsPatch; parent?: string }): Promise<Opened>;
  /** Восстановление вышедшей сессии вручную в её вкладке (`sessions.restore`). */
  restore(doc: string): Promise<Opened>;
  /** Новый билет на идущую сессию: вид после перезагрузки окна просит его, прежний одноразовый. */
  present(sessionId: string): Promise<string>;
  /** При активации: оставленные pty возвращаются на свои вкладки. */
  adopt(): Promise<void>;
}

/**
 * Дополнительные аргументы запуска (ключ плагина Claude Code) встают сразу за именем скрипта: оболочка входа получает `-lc <скрипт> <argv0> <аргументы claude...>`,
 * а скрипт агента передаёт "$@" в claude. Форма другая (агент не из семьи claude) - запуск идёт как есть.
 */
function withArgs(spec: LaunchSpec, extra: readonly string[]): LaunchSpec {
  if (extra.length === 0 || spec.args[0] !== '-lc' || spec.args.length < 3) return spec;
  return { ...spec, args: [...spec.args.slice(0, 3), ...extra, ...spec.args.slice(3)] };
}

export function createLauncher(ctx: PluginContext, pty: OsPty, registry: Registry, hooks?: LauncherHooks): Launcher {
  let counter = 0;
  const factsCache = new Map<string, { at: number; facts: AgentFacts }>();
  const agents = (): AgentProvider[] => ctx.contracts.all('cyborg.agent', 1).toSorted(byId);

  async function factsOf(provider: AgentProvider): Promise<AgentFacts> {
    const cached = factsCache.get(provider.pluginId);
    if (cached && Date.now() - cached.at < FACTS_TTL_MS) return cached.facts;
    const facts = await provider.impl.facts();
    if (facts.found) factsCache.set(provider.pluginId, { at: Date.now(), facts });
    else factsCache.delete(provider.pluginId);
    return facts;
  }

  /** Агент по имени плагина; не назван - первый найденный по порядку id. */
  async function pick(name: string | undefined): Promise<{ provider: AgentProvider; facts: AgentFacts }> {
    const all = agents();
    if (name !== undefined) {
      const provider = all.find((p) => p.pluginId === name);
      if (!provider) throw new Error(`агента ${name} нет`);
      const facts = await factsOf(provider);
      if (!facts.found) throw new Error(`${facts.title}: программа не найдена`);
      return { provider, facts };
    }
    let first: AgentFacts | undefined;
    for (const provider of all) {
      const facts = await factsOf(provider).catch((error: unknown) => {
        ctx.log(`${provider.pluginId}: факты - ${String(error)}`, 'warn');
        return undefined;
      });
      if (facts?.found) return { provider, facts };
      first ??= facts;
    }
    throw new Error(first ? `${first.title}: программа не найдена` : 'нет ни одного агента (cyborg.agent)');
  }

  /** Сессия стартует только в репозиториях проектов (sessionDirsAllowed в ai-cyborg). */
  async function checkDirs(input: CreateInput): Promise<void> {
    const projects = ctx.contracts.get('cyborg.projects', 1);
    if (!projects) throw new Error('cyborg.projects недоступен: проекты не загружены');
    const repos = new Set((await projects.list()).flatMap((p) => p.repos));
    if (!repos.has(input.cwd) || !input.addDirs.every((d) => repos.has(d))) throw new Error('Каталог не входит в репозитории проектов');
  }

  async function present(sessionId: string): Promise<string> {
    const handle = registry.live(sessionId)?.handle;
    if (!handle) throw new Error(`сессии ${sessionId} нет`);
    return handle.share();
  }

  /**
   * Сессия за вкладкой: события агента, выход процесса, документ. Общее у нового запуска и у подхвата оставленного pty.
   * Возвращает запуск слежения за событиями: он ждёт фактов поставщика, а подхват не должен ждать их, пока идёт льготный срок ядра.
   */
  function track(tab: Tab, handle: PtyHandle, provider: AgentProvider | undefined, saved: Saved): (facts: AgentFacts) => void {
    const { sessionId } = tab;
    let name = tab.agent;
    let over = false;
    let unwatch: (() => void) | undefined;
    let resumeId = saved.resumeId;
    handle.onExit((exit) => {
      over = true;
      const closedByUser = registry.get(sessionId) !== tab;
      if (!closedByUser) registry.ended(sessionId);
      registry.emit(tab, { type: 'exit', code: exit.code });
      if (closedByUser) hooks?.closed?.(sessionId);
      hooks?.ended(sessionId);
      unwatch?.();
      if (!provider) return;
      void provider.impl.ended(sessionId, exit).then(
        (hint) => ctx.log(`${name} ${sessionId}: вышла с ${String(exit.code)}${hint ? ` - ${hint.message}` : ''}`),
        () => ctx.log(`${name} ${sessionId}: вышла с ${String(exit.code)}`),
      );
    });
    return (facts) => {
      name = facts.id;
      if (over || !provider || !facts.capabilities.events) return;
      const watch = provider.impl.watch(sessionId, (e) => {
        ctx.log(`${facts.id} ${sessionId}: ${describe(e)}`);
        hooks?.event(tab, e);
        const change = sessionChange(e);
        if (change) registry.emit(tab, change);
        // Документ закрыт человеком - сохранять некуда.
        if (e.type === 'session' && registry.get(sessionId) === tab) {
          resumeId = e.resumeId;
          void ctx.documents.save(tab.doc, { data: dataOf({ ...saved, resumeId }) }).catch(() => undefined);
        }
      });
      unwatch = () => void watch.then((w) => w.dispose());
    };
  }

  async function open(input: CreateInput, options: { labels?: SessionLabelsPatch; parent?: string } = {}, existing?: DocumentInfo): Promise<Opened> {
    await checkDirs(input);
    const { provider, facts } = await pick(input.agent);
    if (input.resumeId !== undefined) {
      if (!facts.capabilities.resume) throw new Error(`${facts.title}: продолжение сессий не поддерживается`);
      // Только явная просьба продолжить прошлую сессию сверяется с историей (session:resume); документ своей сессии сверять не с чем: журнал мог уйти, а `ended` назовёт причину.
      if (existing === undefined && facts.capabilities.history && !(await provider.impl.history(input.cwd)).some((h) => h.id === input.resumeId)) throw new Error('Журнал сессии не найден');
    }
    // Файлы событий агента лежат в общем `plugin-data`: счётчик и время двух окон могут совпасть, поэтому в id есть случайная часть.
    const sessionId = `s${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    // Восстановленная вкладка остаётся в своей семье (родитель и семья лежат в документе), новая - у того, кто её открыл.
    const lineage: Lineage = existing !== undefined ? lineageIn(existing.data) : (hooks?.lineageOf(options.parent) ?? {});
    const prepared = await hooks?.prepare(sessionId);
    const promptFragments = [...(await collectFragments(ctx.contracts.all('cyborg.session-prompt', 1), (m) => ctx.log(m))), ...(prepared?.fragments ?? [])];
    let handle: PtyHandle;
    try {
      const spec = await provider.impl.launch({
        sessionId,
        cwd: input.cwd,
        ...(input.addDirs.length > 0 && { extraDirs: input.addDirs }),
        ...(input.prompt !== undefined && { prompt: input.prompt }),
        ...(input.resumeId !== undefined && { resumeId: input.resumeId }),
        ...(promptFragments.length > 0 && { promptFragments }),
        ...(prepared?.tools && { tools: prepared.tools }),
      });
      try {
        handle = await pty.spawn({ ...withArgs(spec, prepared?.args ?? []), cols: COLS, rows: ROWS, persist: true, describedBy: provider.pluginId });
      } catch (error) {
        // Поставщик уже завёл файлы сессии: убирает он.
        await provider.impl.ended(sessionId, { code: -1 }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      factsCache.delete(provider.pluginId);
      hooks?.ended(sessionId);
      throw error;
    }
    const title = existing?.title ?? `${facts.title} ${String(++counter)}`;
    const saved: Saved = { agent: provider.pluginId, sessionId, pty: `${handle.id}:${String(handle.pid)}`, cwd: input.cwd, addDirs: input.addDirs, lineage, ...(input.resumeId !== undefined && { resumeId: input.resumeId }) };
    let doc: string;
    try {
      if (existing) {
        doc = existing.id;
        await ctx.documents.save(doc, { title, data: dataOf(saved) });
      } else doc = await ctx.documents.open('session', { title, data: dataOf(saved) });
    } catch (error) {
      hooks?.ended(sessionId);
      await handle.kill().catch(() => undefined);
      throw error;
    }
    const previous = registry.byDoc(doc);
    if (previous) registry.remove(previous.sessionId);
    const tab: Tab = { sessionId, doc, title, agent: provider.pluginId, dirs: [input.cwd, ...input.addDirs], handle };
    registry.add(tab);
    hooks?.attach(tab, lineage, false);
    if (options.labels) registry.setLabels(sessionId, options.labels);
    track(tab, handle, provider, saved)(facts);
    ctx.log(`${facts.title}: сессия ${sessionId}, pid ${String(handle.pid)}`);
    return { sessionId, title, ticket: await handle.share() };
  }

  async function restore(docId: string): Promise<Opened> {
    const doc = (await ctx.documents.list()).find((d) => d.id === docId);
    if (!doc) throw new Error(`документа ${docId} нет`);
    if (registry.byDoc(doc.id)?.handle) throw new Error(`${doc.title}: сессия уже идёт`);
    const resumeId = field(doc.data, 'resumeId');
    const input = validateCreateInput({ cwd: field(doc.data, 'cwd'), addDirs: strings(doc.data, 'addDirs'), agent: field(doc.data, 'agent'), ...(resumeId !== undefined && { resumeId }) });
    if (typeof input === 'string') throw new Error(`${doc.title}: данные вкладки не годятся (${input})`);
    return open(input, {}, doc);
  }

  /**
   * Оставленные pty (хост плагина перезапущен или человек выключил плагин с «Оставить работать»): с активации идёт льготный срок ядра,
   * и не взятый через `attach` процесс по его концу завершается. Документ сессии помнит свой pty, по нему сессия возвращается на вкладку.
   */
  async function adopt(): Promise<void> {
    const [docs, left] = await Promise.all([ctx.documents.list(), pty.list()]);
    for (const info of left) {
      const doc = docs.find((d) => field(d.data, 'pty') === `${info.id}:${String(info.pid)}`);
      const sessionId = field(doc?.data, 'sessionId');
      const agent = field(doc?.data, 'agent');
      const cwd = field(doc?.data, 'cwd');
      if (doc === undefined || sessionId === undefined || agent === undefined || cwd === undefined || registry.get(sessionId)) continue;
      const handle = await pty.attach(info.id);
      const provider = agents().find((p) => p.pluginId === agent);
      const addDirs = strings(doc.data, 'addDirs');
      const resumeId = field(doc.data, 'resumeId');
      const tab: Tab = { sessionId, doc: doc.id, title: doc.title, agent, dirs: [cwd, ...addDirs], handle };
      registry.add(tab);
      const lineage = lineageIn(doc.data);
      hooks?.attach(tab, lineage, true);
      const watching = track(tab, handle, provider, { agent, sessionId, pty: `${info.id}:${String(info.pid)}`, cwd, addDirs, lineage, ...(resumeId !== undefined && { resumeId }) });
      ctx.log(`${doc.title}: подхвачена оставленная сессия, pid ${String(handle.pid)}`);
      void provider?.impl.facts().then(watching, (error: unknown) => ctx.log(`${agent}: факты подхваченной сессии - ${String(error)}`, 'warn'));
    }
  }

  return { agents, open: (input, options) => open(input, options), restore, present, adopt };
}
