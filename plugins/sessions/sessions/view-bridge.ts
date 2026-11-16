import type { PluginContext, SessionChange } from '@cyborg-harness/contracts';
import type { SessionsV12 } from '@cyborg-plugins/contracts';
import { validateSessionId } from './args.ts';
import type { Launcher } from './launcher.ts';
import { openablePath, webUrl } from './open-link.ts';
import type { Registry } from './registry.ts';
import { composeTitle, type TabInfo, type TabState } from './tab-info.ts';

// Связь главной части с видами `main` («Сессии») и `history` («Сессии проекта»): команды, которые зовёт вид, и толчки по каналу.
// Вид ничего не хранит: вкладки, состояние и метки у главной части, вид перечитывает их командой `sessions.tabs`, когда пришёл толчок.
// Метки и составленные из них заголовки живут только в памяти (FR-1015, FR-2014): сюда они приходят из реестра и в документы не пишутся.

/** Что главная часть сообщает виду `main` по каналу. Сообщение - толчок: подробности вид спрашивает командой. */
export type MainMessage =
  /** Вкладки, состояние или метки изменились. */
  | { readonly type: 'tabs' }
  /** Показать вкладку сессии (`cyborg.sessions.reveal`). */
  | { readonly type: 'reveal'; readonly doc: string }
  /** Сочетание клавиш: новая сессия. */
  | { readonly type: 'new-session' }
  /** Сочетание клавиш: размер шрифта по умолчанию. */
  | { readonly type: 'font-reset' };

interface Runtime {
  state: TabState;
  reason: string | undefined;
  cwd: string | null;
}

/** Запись истории для вида «Сессии проекта». */
export interface HistoryRow {
  readonly id: string;
  /** Репозиторий проекта, в чьём каталоге (или worktree) шла сессия. */
  readonly repo: string;
  /** Плагин-агент, чья это история. */
  readonly agent: string;
  readonly title: string;
  readonly updated: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface Bridge {
  /** Члены контракта поверх готовых: `reveal` просит вид показать вкладку, `create` и `setLabels` толкают вид. */
  decorate(contract: SessionsV12): SessionsV12;
  /** Вкладки изменились: вид перечитает. */
  nudge(): void;
  /** Сессию открыли командой (в том числе из вида «Сессии проекта»): вкладки перечитываются, новая показывается. */
  opened(sessionId: string): void;
  /** Выбранный проект сменился: вид «Сессии проекта» перечитывает историю. */
  projectChanged(): void;
  tabs(): Promise<TabInfo[]>;
  /** Вкладку закрыл человек в окне или вид: процесс завершается, метки уходят. */
  closeTab(doc: string): Promise<void>;
}

export function createBridge(ctx: PluginContext, registry: Registry, launcher: Launcher): Bridge {
  const channel = ctx.views.channel('main');
  const post = (message: MainMessage): void => void channel.post(message).catch(() => undefined);
  const runtime = new Map<string, Runtime>();
  const stateOf = (sessionId: string): Runtime => {
    let r = runtime.get(sessionId);
    if (!r) runtime.set(sessionId, (r = { state: 'starting', reason: undefined, cwd: null }));
    return r;
  };
  const history = ctx.views.channel('history');
  const nudge = (): void => {
    post({ type: 'tabs' });
    void history.post({ changed: true }).catch(() => undefined);
  };

  // Состояние вкладки идёт от тех же событий, что получают остальные плагины: работает, ждёт человека, вышла, сменила каталог.
  registry.onChange(({ sessionId, change }) => {
    const r = stateOf(sessionId);
    const before = `${r.state}|${r.reason ?? ''}|${r.cwd ?? ''}`;
    apply(r, change);
    if (before !== `${r.state}|${r.reason ?? ''}|${r.cwd ?? ''}`) nudge();
  });

  async function tabs(): Promise<TabInfo[]> {
    const docs = await ctx.documents.list();
    return docs.map((doc): TabInfo => {
      const tab = registry.byDoc(doc.id);
      const data = typeof doc.data === 'object' && doc.data !== null ? (doc.data as Record<string, unknown>) : {};
      if (!tab) {
        return {
          doc: doc.id,
          sessionId: null,
          title: doc.title,
          agent: typeof data.agent === 'string' ? data.agent : '',
          cwd: typeof data.cwd === 'string' ? data.cwd : null,
          state: 'exited',
          labels: {},
          previous: true,
        };
      }
      const labels = registry.labels(tab.sessionId) ?? {};
      const r = stateOf(tab.sessionId);
      const state: TabState = tab.handle ? r.state : 'exited';
      return {
        doc: doc.id,
        sessionId: tab.sessionId,
        title: composeTitle(tab.title, labels),
        agent: tab.agent,
        cwd: r.cwd ?? tab.dirs[0] ?? null,
        state,
        ...(state === 'waiting' && r.reason !== undefined && { reason: r.reason }),
        labels,
        previous: false,
      };
    });
  }

  async function closeTab(doc: string): Promise<void> {
    const tab = registry.byDoc(doc);
    if (tab) {
      registry.remove(tab.sessionId);
      runtime.delete(tab.sessionId);
      await tab.handle?.kill().catch(() => undefined);
    }
    await ctx.documents.close(doc);
    nudge();
  }

  function decorate(contract: SessionsV12): SessionsV12 {
    return {
      ...contract,
      async reveal(sessionId) {
        await contract.reveal(sessionId);
        const tab = registry.get(sessionId);
        if (tab) post({ type: 'reveal', doc: tab.doc });
      },
      async create(request) {
        const handle = await contract.create(request);
        nudge();
        return handle;
      },
      async setLabels(sessionId, patch) {
        const labels = await contract.setLabels(sessionId, patch);
        nudge();
        return labels;
      },
    };
  }

  registerViewCommands(ctx, launcher, { tabs, closeTab, post });
  const opened = (sessionId: string): void => {
    nudge();
    const tab = registry.get(sessionId);
    if (tab) post({ type: 'reveal', doc: tab.doc });
  };
  const projectChanged = (): void => void history.post({ changed: true }).catch(() => undefined);
  return { decorate, nudge, opened, projectChanged, tabs, closeTab };
}

function apply(r: Runtime, change: SessionChange): void {
  switch (change.type) {
    case 'cwd':
      r.cwd = change.cwd;
      return;
    case 'activity':
      r.state = 'working';
      r.reason = undefined;
      return;
    case 'waiting':
      r.state = 'waiting';
      r.reason = change.reason;
      return;
    case 'exit':
      r.state = 'exited';
      r.reason = undefined;
      return;
  }
}

interface Hooks {
  tabs(): Promise<TabInfo[]>;
  closeTab(doc: string): Promise<void>;
  post(message: MainMessage): void;
}

/** Команды видов. Открыты только человеку (вид зовёт их как пользователь), другие плагины работают через контракт. */
function registerViewCommands(ctx: PluginContext, launcher: Launcher, hooks: Hooks): void {
  ctx.commands.register('sessions.tabs', () => hooks.tabs());
  ctx.commands.register('sessions.close-tab', (doc) => hooks.closeTab(String(doc)));
  // Сочетания клавиш ловит ядро, а не фрейм вида: команда по сочетанию толкает вид.
  ctx.commands.register('sessions.new-request', () => hooks.post({ type: 'new-session' }));
  ctx.commands.register('sessions.font-reset', () => hooks.post({ type: 'font-reset' }));

  // Пути и ссылки из вывода (FR-10012): форма проверяется здесь, исполняемое и вне областей ядро не откроет (право shell).
  ctx.commands.register('sessions.open-path', async (value) => {
    const target = openablePath(value, ctx.os.paths.home);
    if ('error' in target) throw new Error(target.error);
    if (!ctx.os.shell?.openPath) throw new Error('открывать файлы в системе нельзя: нет права shell');
    await ctx.os.shell.openPath(target.path);
  });
  ctx.commands.register('sessions.open-url', async (value) => {
    const url = webUrl(value);
    if (url === null) throw new Error('Открываются только ссылки http и https');
    if (!ctx.os.shell?.openExternal) throw new Error('открывать ссылки в системе нельзя: нет права shell');
    await ctx.os.shell.openExternal(url);
  });
  // Буфер обмена: у вида его нет (navigator.clipboard во фрейме закрыт), копирование и вставку просит главная часть.
  ctx.commands.register('sessions.copy', async (text) => {
    if (typeof text !== 'string' || text.length > 4 * 1024 * 1024) throw new Error('Копируется строка до 4 МиБ');
    const clipboard = ctx.os.clipboard;
    if (!clipboard?.writeText) throw new Error('буфер обмена недоступен: нет права clipboard');
    await clipboard.writeText(text);
  });
  ctx.commands.register('sessions.paste-text', async () => {
    const clipboard = ctx.os.clipboard;
    if (!clipboard?.readText) throw new Error('буфер обмена недоступен: нет права clipboard');
    return clipboard.readText();
  });

  // Сессии проекта (history:list, history:delete): проект называет вид по id, репозитории - из `cyborg.projects`; список - `cyborg.agent.history`, удаление - команда агента.
  const reposOf = async (projectId: unknown): Promise<readonly string[]> => {
    if (typeof projectId !== 'string') throw new Error('Некорректные аргументы');
    const projects = ctx.contracts.get('cyborg.projects', 1);
    const project = (await projects?.list())?.find((p) => p.id === projectId);
    if (!project) throw new Error('Проект не найден');
    return project.repos;
  };
  ctx.commands.register('sessions.history.list', async (projectId) => {
    const repos = await reposOf(projectId);
    const rows: HistoryRow[] = [];
    for (const provider of launcher.agents()) {
      for (const repo of repos) {
        for (const entry of await provider.impl.history(repo).catch((error: unknown) => {
          ctx.log(`${provider.pluginId}: история ${repo} - ${messageOf(error)}`, 'warn');
          return [];
        })) {
          rows.push({ id: entry.id, repo, agent: provider.pluginId, title: entry.title, updated: entry.updated });
        }
      }
    }
    return rows.sort((a, b) => b.updated - a.updated);
  });
  ctx.commands.register('sessions.history.delete', async (projectId, repo, ids, agent) => {
    const repos = await reposOf(projectId);
    if (typeof repo !== 'string' || !repos.includes(repo) || !Array.isArray(ids) || !ids.every((id) => validateSessionId(id) !== null)) throw new Error('Некорректное удаление сессии');
    const owner = launcher.agents().find((p) => p.pluginId === agent);
    if (!owner) throw new Error(`агента ${String(agent)} нет`);
    return ctx.commands.run(`${owner.pluginId}.history.delete`, repo, ids);
  });
}
