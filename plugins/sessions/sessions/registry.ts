import type { PtyHandle, SessionChange, SessionEvent, Subscription } from '@cyborg-harness/contracts';
import type { SessionBinding, SessionBindingKind, SessionLabels, SessionLabelsPatch } from '@cyborg-plugins/contracts';

// Реестр сессий плагина: вкладки (идущие и вышедшие), метки и подписчики `cyborg.sessions.onChange`. Состояние только в памяти процесса плагина:
// метки (привязка задачи и MR) не пишутся на диск (FR-1015, FR-2014), в документ вкладки они не попадают.

/** Вкладка сессии. Вышедшая сессия остаётся вкладкой (её можно открыть и восстановить), но `handle` у неё уже нет. */
export interface Tab {
  readonly sessionId: string;
  /** Документ вкладки в окне. */
  readonly doc: string;
  readonly title: string;
  /** Плагин-агент (`id` поставщика `cyborg.agent`). */
  readonly agent: string;
  /** Каталоги запуска: рабочий и подключённые через `--add-dir`. */
  readonly dirs: readonly string[];
  /** Терминал, пока процесс идёт. */
  handle: PtyHandle | undefined;
}

const KINDS: readonly SessionBindingKind[] = ['task', 'mr'];

export class Registry {
  private readonly tabs = new Map<string, Tab>();
  private readonly labelsOf = new Map<string, SessionLabels>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly onListenerError: (error: unknown) => void;

  constructor(onListenerError: (error: unknown) => void) {
    this.onListenerError = onListenerError;
  }

  add(tab: Tab): void {
    this.tabs.set(tab.sessionId, tab);
  }

  get(sessionId: string): Tab | undefined {
    return this.tabs.get(sessionId);
  }

  byDoc(doc: string): Tab | undefined {
    for (const tab of this.tabs.values()) if (tab.doc === doc) return tab;
    return undefined;
  }

  /** Идущая сессия: у неё есть терминал. */
  live(sessionId: string): Tab | undefined {
    const tab = this.tabs.get(sessionId);
    return tab?.handle ? tab : undefined;
  }

  liveTabs(): Tab[] {
    return [...this.tabs.values()].filter((t) => t.handle);
  }

  /** Вкладку закрыл человек: сессии за ней нет, метки уходят вместе с ней. */
  remove(sessionId: string): void {
    this.tabs.delete(sessionId);
    this.labelsOf.delete(sessionId);
  }

  /** Процесс вышел: вкладка остаётся, привязки снимаются (задача снова без сессии). */
  ended(sessionId: string): void {
    const tab = this.tabs.get(sessionId);
    if (tab) tab.handle = undefined;
    this.labelsOf.delete(sessionId);
  }

  /** Работающая сессия, запущенная с каталогом `root` (рабочим или из `--add-dir`): ветку под ней менять нельзя. Текущий каталог после перехода в worktree не считается. */
  uses(root: string): boolean {
    return this.liveTabs().some((t) => t.dirs.includes(root));
  }

  labels(sessionId: string): SessionLabels | null {
    return this.tabs.has(sessionId) ? (this.labelsOf.get(sessionId) ?? {}) : null;
  }

  /** Правка меток; привязку к тому же объекту трекера, которую держала другая сессия, забирает эта. */
  setLabels(sessionId: string, patch: SessionLabelsPatch): SessionLabels {
    if (!this.tabs.has(sessionId)) throw new Error(`нет сессии ${sessionId}`);
    const next: { -readonly [K in SessionBindingKind]?: SessionBinding } = { ...this.labelsOf.get(sessionId) };
    for (const kind of KINDS) {
      const change = patch[kind];
      if (change === undefined) continue;
      if (change === null) {
        delete next[kind];
        continue;
      }
      next[kind] = { key: change.key, title: change.title, ...(change.status !== undefined && { status: change.status }), ...(change.url !== undefined && { url: change.url }) };
      for (const [other, labels] of this.labelsOf) {
        if (other === sessionId || labels[kind]?.key !== change.key) continue;
        const { [kind]: _taken, ...rest } = labels;
        this.labelsOf.set(other, rest);
      }
    }
    this.labelsOf.set(sessionId, next);
    return next;
  }

  /** Живая сессия, привязанная к объекту трекера. */
  find(kind: SessionBindingKind, key: string): string | null {
    for (const tab of this.liveTabs()) if (this.labelsOf.get(tab.sessionId)?.[kind]?.key === key) return tab.sessionId;
    return null;
  }

  onChange(listener: (event: SessionEvent) => void): Subscription {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  /** Событие сессии всем подписчикам; вкладку могли уже закрыть, поэтому она передаётся сама. Слушатель, бросивший исключение, соседям не мешает. */
  emit(tab: Pick<Tab, 'sessionId' | 'title'>, change: SessionChange): void {
    const event: SessionEvent = { sessionId: tab.sessionId, title: tab.title, change };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }
}
