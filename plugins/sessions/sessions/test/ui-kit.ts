// `UiContext` вида плагина sessions поверх настоящего ядра: команды - `kernel.runOwn`, диалоги - слой диалогов ядра (`showDialog`, ответ человека - `answerDialog`),
// терминал - настоящий билет `pty.share()` и порт сообщений pty-хоста (вывод идёт мимо хоста плагина), канал - сообщения главной части плагина виду.
// Терминал xterm подменён записывающим (TermFacade): настоящий xterm.js и canvas в Node не живут.

import type { DialogSpec, Disposable, PtyExit, UiContext, UiTerminal } from '@cyborg-harness/contracts';
import { mountSessions } from '../ui/session-view.ts';
import type { TermFacade, TermFactory, TermHooks, TermInit } from '../ui/term-facade.ts';
import { FakeElement, until, withDocument } from './dom.ts';
import type { Rig } from './kit.ts';

export const asRoot = (e: FakeElement): HTMLElement => e as unknown as HTMLElement;

/** Терминал, записывающий вызовы вида. */
export class FakeTerm implements TermFacade {
  readonly hooks: TermHooks;
  fontSize: number;
  writes: string[] = [];
  pasted: string[] = [];
  focused = 0;
  fits = 0;
  opened: unknown;
  disposed = false;
  resets = 0;
  theme: unknown;
  cols = 100;
  rows = 30;
  constructor(hooks: TermHooks, init: TermInit) {
    this.hooks = hooks;
    this.fontSize = init.fontSize;
  }
  open(host: HTMLElement): void {
    this.opened = host;
  }
  write(data: string): void {
    this.writes.push(data);
  }
  paste(text: string): void {
    this.pasted.push(text);
  }
  reset(): void {
    this.resets++;
  }
  focus(): void {
    this.focused++;
  }
  fit(): void {
    this.fits++;
    this.hooks.resize(this.cols, this.rows);
  }
  setFontSize(size: number): void {
    this.fontSize = size;
  }
  setTheme(tokens: unknown): void {
    this.theme = tokens;
  }
  size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }
  dispose(): void {
    this.disposed = true;
  }
  /** Всё, что дошло до экрана. */
  get text(): string {
    return this.writes.join('');
  }
}

export interface UiRig {
  readonly ctx: UiContext;
  readonly terms: FakeTerm[];
  readonly makeTerm: TermFactory;
  /** Сообщения, которые вид отправил главной части. */
  readonly state: { value: unknown; saved: unknown[] };
  /** Ответ `ctx.drag.drop()`. */
  drop: { value: { from: string; path: string } | null };
  /** Что просили терминалы ядра: билеты и закрытия. */
  readonly closedTerminals: string[];
  /** Ответить на диалог ядра, когда он покажется; ответ - id кнопки. */
  answer(id: string): Promise<DialogSpec>;
  /** Следующий показанный диалог (без ответа). */
  dialog(): Promise<{ id: number; spec: DialogSpec }>;
  dispose(): void;
}

export interface UiOptions {
  readonly state?: unknown;
  /** Не пускать в `state.set` (память недоступна). */
  readonly stateFails?: boolean;
}

/** Подставной `UiContext` для вида `view` плагина `sessions`. */
export function uiRig(r: Rig, view: string, options: UiOptions = {}): UiRig {
  const terms: FakeTerm[] = [];
  const closedTerminals: string[] = [];
  const state = { value: options.state, saved: [] as unknown[] };
  const drop: UiRig['drop'] = { value: null };
  const subscriptions: Disposable[] = [];
  const opened: { close(): void }[] = [];
  const makeTerm: TermFactory = (hooks, init) => {
    const term = new FakeTerm(hooks, init);
    terms.push(term);
    return term;
  };

  const terminalOpen = async (ticket: string): Promise<UiTerminal> => {
    const channel = new MessageChannel();
    const view = await r.kernel.openTerminal('sessions', ticket, { hostEnd: channel.port1, closed: () => void closedTerminals.push(ticket) } as never);
    const dataListeners = new Set<(chunk: string) => void>();
    const exitListeners = new Set<(exit: PtyExit) => void>();
    let seq = 0;
    const waiting = new Map<number, { resolve(): void; reject(e: Error): void }>();
    channel.port2.onmessage = (event: MessageEvent<{ data?: string; exit?: PtyExit; id?: number; ok?: boolean; error?: string }>) => {
      const m = event.data;
      if (typeof m.data === 'string') for (const l of dataListeners) l(m.data);
      if (m.exit) for (const l of exitListeners) l(m.exit);
      if (typeof m.id === 'number') {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error !== undefined) w?.reject(new Error(m.error));
        else w?.resolve();
      }
    };
    const call = (op: string, payload: Record<string, unknown>): Promise<void> =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        channel.port2.postMessage({ id, op, ...payload });
      });
    const handle = {
      close: () => {
        channel.port2.close();
        view.close();
      },
    };
    opened.push(handle);
    return {
      id: view.id,
      pid: view.pid,
      program: view.program,
      args: view.args,
      persist: view.persist,
      backlog: view.backlog,
      onData: (l) => (dataListeners.add(l), { dispose: () => void dataListeners.delete(l) }),
      onExit: (l) => (exitListeners.add(l), { dispose: () => void exitListeners.delete(l) }),
      write: (data) => call('write', { data }),
      resize: (cols, rows) => call('resize', { cols, rows }),
      close: handle.close,
    };
  };

  const projects = {
    selected: async () => (r.projects.selectedName === null ? null : { id: 'p1', name: r.projects.selectedName, description: '', repos: [...r.projects.repos] }),
    list: async () => [{ id: 'p1', name: 'Проект', description: '', repos: [...r.projects.repos] }],
  };
  const ctx = {
    pluginId: 'sessions',
    view,
    commands: { run: (command: string, ...args: unknown[]) => r.kernel.runOwn('sessions', command, ...args) },
    contracts: { get: async (name: string) => (name === 'cyborg.projects' ? projects : undefined) },
    theme: { tokens: {}, onChange: () => ({ dispose() {} }) },
    visible: true,
    onVisibilityChange: () => ({ dispose() {} }),
    terminal: { open: terminalOpen },
    state: {
      get value() {
        return state.value;
      },
      set: async (value: unknown) => {
        if (options.stateFails) throw new Error('память вида недоступна');
        state.value = value;
        state.saved.push(structuredClone(value));
      },
    },
    dialogs: { show: (spec: DialogSpec) => r.kernel.showDialog('sessions', view, spec) },
    channel: {
      post: async () => undefined,
      onMessage: (listener: (m: unknown) => void) => r.onView(view, listener),
    },
    drag: { start: () => undefined, drop: async () => drop.value },
    modal: undefined,
  } as unknown as UiContext;

  return {
    ctx,
    terms,
    makeTerm,
    state,
    drop,
    closedTerminals,
    async dialog() {
      return until(() => r.kernel.window.dialog, 'диалог показан') as Promise<{ id: number; spec: DialogSpec }>;
    },
    async answer(id) {
      const shown = await until(() => r.kernel.window.dialog, 'диалог показан');
      r.kernel.answerDialog(shown.id, id);
      await until(() => r.kernel.window.dialog === undefined, 'диалог закрыт');
      return shown.spec;
    },
    dispose() {
      for (const s of subscriptions) s.dispose();
      for (const o of opened) o.close();
    },
  };
}

/** Заголовок диалога вопроса. */
export const titleOf = (spec: DialogSpec): string => (spec.kind === 'ask' ? spec.title : '');

export interface Mounted {
  readonly root: FakeElement;
  readonly ui: UiRig;
  readonly tabs: () => FakeElement[];
  view: { dispose(): void };
}

/** Монтирует вид и возвращает его корень; `body` выполняется с подменённым `document`. */
export async function mounted<T>(r: Rig, body: (m: Mounted) => Promise<T>, options: UiOptions & { focused?: () => boolean } = {}): Promise<T> {
  return withDocument(async () => {
    const root = new FakeElement('div');
    const ui = uiRig(r, 'main', options);
    const view = mountSessions(asRoot(root), ui.ctx, { makeTerm: ui.makeTerm, commandKey: (e) => e.ctrlKey, ...(options.focused && { focused: options.focused }) });
    try {
      return await body({ root, ui, tabs: () => root.find('strip').children, view });
    } finally {
      view.dispose();
      ui.dispose();
    }
  });
}



export const labelOf = (tab: FakeElement): string => tab.byClass('label')[0]?.textContent ?? '';
