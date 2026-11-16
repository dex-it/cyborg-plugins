import type { Disposable, UiContext, UiTerminal } from '@cyborg-harness/contracts';
import { cy, el } from './dom.ts';
import { returnTarget, tabTooltip, type TabInfo } from '../tab-info.ts';
import { dropIntoSession, TREE_PATH_MIME } from './drop-path.ts';
import { DEFAULT_FONT_SIZE, stepFontSize, WheelStepper } from './font-size.ts';
import { neighborAfterClose } from './neighbor.ts';
import { OutputGate } from './output-gate.ts';
import { moveItem } from './reorder.ts';
import { bindTabDrag, bindTablist, markTab, selectTab } from './tabs.ts';
import type { TermFacade, TermFactory } from './term-facade.ts';
import { DecModes } from './term-modes.ts';
import { applyOrder, ViewMemory } from './view-memory.ts';

// Вид «Сессии»: полоса вкладок и терминалы. Вкладки, состояние и метки - у главной части (`sessions.tabs`), вид ничего не хранит, кроме памяти вида
// (размер шрифта, порядок вкладок, режимы терминала) и перечитывает вкладки по толчку канала. Вывод идёт из ядра прямо в терминал по билету `pty.share()`,
// мимо хоста плагина; ввод и размер вид отправляет в тот же терминал. Диалоги - слой ядра (вместо alert и confirm окна ai-cyborg).

const SESSION_COLORS = ['#d97757', '#3b82f6', '#10b981', '#a855f7', '#f59e0b', '#ec4899', '#14b8a6', '#6366f1'];
/** Цвет вкладки по документу: тот же у одной вкладки в любом запуске, у соседних разный. */
export function sessionColor(doc: string): string {
  let hash = 0;
  for (const ch of doc) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SESSION_COLORS[hash % SESSION_COLORS.length] ?? '#d97757';
}

const STATE_LABEL: Readonly<Record<TabInfo['state'], string>> = { starting: 'идёт', working: 'работает', waiting: 'ждёт', exited: 'вышла' };
const MODES_SAVE_MS = 1000;
const encoder = new TextEncoder();
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Подписи репозиториев для меню: имя каталога; у совпавших имён - два последних сегмента; не длиннее 80 знаков (предел пункта меню ядра).
 * Полный путь в меню не помещается и человеку не нужен: репозитории проекта он узнаёт по имени.
 */
export function repoLabels(repos: readonly string[]): string[] {
  const names = repos.map((r) => r.replace(/\/+$/, '').split('/').pop() || r);
  return repos.map((repo, i) => {
    const name = names[i] ?? repo;
    const label = names.filter((n) => n === name).length > 1 ? repo.replace(/\/+$/, '').split('/').slice(-2).join('/') : name;
    return label.length > 80 ? `…${label.slice(-79)}` : label;
  });
}

export interface ViewDeps {
  readonly makeTerm: TermFactory;
  /** Окно в фокусе: без фокуса вывод копится и уходит пачкой (output-gate.ts). По умолчанию `document.hasFocus`. */
  readonly focused?: () => boolean;
  /** Клавиша команд нажата с колесом: Cmd на macOS, Ctrl вне него. По умолчанию по `navigator.platform`. */
  readonly commandKey?: (event: { ctrlKey: boolean; metaKey: boolean }) => boolean;
}

/** Всё, что вид держит про одну вкладку. */
interface Pane {
  readonly doc: string;
  info: TabInfo;
  readonly tab: HTMLElement;
  readonly label: HTMLElement;
  readonly body: HTMLElement;
  readonly host: HTMLElement;
  readonly notice: HTMLElement;
  term: TermFacade | undefined;
  uiTerm: UiTerminal | undefined;
  /** Сессия, к чьему терминалу вид подключён. */
  attached: string | null;
  attaching: boolean;
  modes: DecModes;
  modesTimer: ReturnType<typeof setTimeout> | undefined;
  subscriptions: Disposable[];
  exitCode: number | undefined;
}

export function mountSessions(root: HTMLElement, ctx: UiContext, deps: ViewDeps): Disposable {
  const memory = new ViewMemory(ctx.state);
  const run = (command: string, ...args: unknown[]): Promise<unknown> => ctx.commands.run(command, ...args);
  const commandKey = deps.commandKey ?? ((event) => (/Mac/i.test(navigator.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey));
  const panes = new Map<string, Pane>();
  let order: string[] = [];
  let active: string | null = null;
  let fontSize = memory.fontSize;
  let disposed = false;

  // ---------- разметка ----------
  const strip = el('nav', { id: 'strip' });
  bindTablist(strip, 'Сессии');
  const create = cy('cy-button', { id: 'new', textContent: '+ Новая сессия', title: 'Новая сессия (Ctrl+Shift+N, на macOS Cmd+Shift+N)' });
  const bar = el('header', { id: 'bar' });
  bar.append(strip, create);
  const stage = el('div', { id: 'stage' });
  const empty = cy('cy-empty', { id: 'empty', textContent: 'Выберите проект и откройте сессию кнопкой «Новая сессия»' });
  empty.setAttribute('heading', 'Нет сессий');
  stage.append(empty);
  const sheet = (href: string) => el('link', { rel: 'stylesheet', href: new URL(href, import.meta.url).href });
  root.append(sheet('./xterm.css'), sheet('./ui.css'), bar, stage);

  // ---------- диалоги слоя ядра ----------
  const ask = (title: string, message: string, confirm?: string): Promise<boolean> =>
    ctx.dialogs
      .show({ kind: 'ask', title, message, buttons: confirm ? [{ id: 'yes', label: confirm }, { id: 'no', label: 'Отмена' }] : [{ id: 'ok', label: 'Закрыть' }] })
      .then((answer) => answer === 'yes' || answer === 'ok');
  const fail = (title: string, error: unknown): void => void ask(title, messageOf(error)).catch(() => undefined);

  // ---------- вывод: окно без фокуса отдаёт его пачкой ----------
  const gate = new OutputGate<Pane>({
    focused: deps.focused ?? (() => document.hasFocus()),
    write: (pane, data) => pane.term?.write(data),
    setTimer: (fn, ms) => void setTimeout(fn, ms),
  });

  // ---------- вкладки ----------
  const hide = (pane: Pane): void => {
    pane.body.hidden = pane.doc !== active;
  };

  function select(doc: string | null): void {
    active = doc !== null && panes.has(doc) ? doc : null;
    for (const pane of panes.values()) {
      selectTab(pane.tab, pane.doc === active);
      hide(pane);
    }
    empty.hidden = panes.size > 0;
    const pane = active === null ? undefined : panes.get(active);
    if (pane?.term) {
      pane.term.fit();
      pane.term.focus();
    }
  }

  function describeTab(pane: Pane): void {
    const { info } = pane;
    pane.label.textContent = info.title;
    pane.tab.title = tabTooltip(info);
    pane.tab.setAttribute('data-state', info.state);
    pane.tab.setAttribute('aria-label', `${info.title}, ${info.previous ? 'прошлый запуск' : STATE_LABEL[info.state]}${info.reason ? `: ${info.reason}` : ''}`);
    const back = returnTarget(info.labels);
    if (back) pane.tab.setAttribute('data-return', back.label);
  }

  function makePane(info: TabInfo): Pane {
    const tab = markTab(el('div', { className: 'tab' }));
    tab.draggable = true;
    tab.style.setProperty('--session', sessionColor(info.doc));
    const dot = el('span', { className: 'dot' });
    const label = el('span', { className: 'label' });
    const close = el('span', { className: 'close', textContent: '×', title: 'Закрыть вкладку' });
    close.setAttribute('role', 'button');
    close.setAttribute('aria-label', 'Закрыть вкладку');
    tab.append(dot, label, close);
    const body = el('div', { className: 'pane' });
    const host = el('div', { className: 'term-host' });
    const notice = el('div', { className: 'notice' });
    notice.hidden = true;
    body.append(host, notice);
    body.style.setProperty('--session', sessionColor(info.doc));
    stage.append(body);
    const pane: Pane = { doc: info.doc, info, tab, label, body, host, notice, term: undefined, uiTerm: undefined, attached: null, attaching: false, modes: new DecModes(), modesTimer: undefined, subscriptions: [], exitCode: undefined };
    tab.addEventListener('click', () => select(pane.doc));
    close.addEventListener('click', (event) => {
      (event as Event).stopPropagation();
      void closeTab(pane);
    });
    // Бросок пути на терминал (FR-3002): путь отдаёт ядро (`ctx.drag.drop`), в терминал он идёт в кавычках оболочки (FR-3003); вне зоны терминала ничего не происходит (FR-3005).
    host.addEventListener('dragover', (event) => {
      const types = Array.from((event as DragEvent).dataTransfer?.types ?? []);
      if (!types.includes('application/x-cyborg-tab')) (event as Event).preventDefault();
    });
    host.addEventListener('drop', (event) => {
      (event as Event).preventDefault();
      void ctx.drag.drop().then((dropped) => {
        if (!dropped || !pane.term) return;
        const text = { types: [TREE_PATH_MIME], getData: () => dropped.path, files: [] as unknown as FileList };
        dropIntoSession({ exited: pane.info.state === 'exited', term: pane.term }, text, () => '', () => select(pane.doc));
      }, () => undefined);
    });
    describeTab(pane);
    return pane;
  }

  async function closeTab(pane: Pane): Promise<void> {
    if (pane.info.state !== 'exited' && !pane.info.previous && !(await ask('Сессия ещё работает', 'Завершить её и закрыть вкладку?', 'Завершить'))) return;
    const next = active === pane.doc ? neighborAfterClose(order, pane.doc) : active;
    try {
      await run('sessions.close-tab', pane.doc);
    } catch (error) {
      return fail('Не удалось закрыть вкладку', error);
    }
    await refresh();
    select(next ?? null);
  }

  // ---------- терминал вкладки ----------
  function showNotice(pane: Pane): void {
    const { info } = pane;
    pane.notice.replaceChildren();
    const exited = info.state === 'exited';
    pane.notice.hidden = !exited;
    if (!exited) return;
    const text = el('span', { textContent: info.previous ? 'Сессия прошлого запуска' : `Сессия завершена${pane.exitCode !== undefined ? ` (код ${String(pane.exitCode)})` : ''}` });
    const restore = cy('cy-button', { textContent: 'Восстановить' });
    restore.setAttribute('variant', 'primary');
    restore.addEventListener('click', () => void run('sessions.restore', pane.doc).then(() => refresh(), (error: unknown) => fail('Сессия не восстановлена', error)));
    pane.notice.append(text, restore);
  }

  function saveModes(pane: Pane): void {
    clearTimeout(pane.modesTimer);
    pane.modesTimer = setTimeout(() => memory.setModes(pane.doc, pane.modes.restore()), MODES_SAVE_MS);
  }

  function detach(pane: Pane): void {
    for (const s of pane.subscriptions) s.dispose();
    pane.subscriptions = [];
    pane.uiTerm?.close();
    pane.uiTerm = undefined;
    gate.drop(pane);
  }

  /** Подключает терминал вкладки к идущей сессии по новому билету: так вид возвращается после перезагрузки окна и подхвата сессии. */
  async function attach(pane: Pane): Promise<void> {
    const sessionId = pane.info.sessionId;
    if (sessionId === null || pane.attaching || pane.attached === sessionId) return;
    pane.attaching = true;
    try {
      const opened = (await run('sessions.reopen', pane.doc)) as { sessionId: string; ticket: string };
      const uiTerm = await ctx.terminal.open(opened.ticket);
      if (disposed) return uiTerm.close();
      detach(pane);
      pane.term?.dispose();
      pane.host.replaceChildren();
      pane.exitCode = undefined;
      const term = deps.makeTerm(
        {
          input: (data) => void uiTerm.write(data).catch(() => undefined),
          resize: (cols, rows) => void uiTerm.resize(cols, rows).catch(() => undefined),
          openPath: (path) => void run('sessions.open-path', path).catch((error: unknown) => fail('Не удалось открыть', error)),
          openUrl: (url) => void run('sessions.open-url', url).catch((error: unknown) => fail('Не удалось открыть ссылку', error)),
          copy: (text) => void run('sessions.copy', text).catch(() => undefined),
          pasteFromClipboard: () => void run('sessions.paste-text').then((text) => typeof text === 'string' && text && term.paste(text), () => undefined),
        },
        { fontSize, tokens: ctx.theme.tokens },
      );
      pane.term = term;
      pane.uiTerm = uiTerm;
      pane.attached = opened.sessionId;
      term.open(pane.host);
      // Режимы терминала, включённые до начала хвоста (Claude включает их один раз), возвращаются перед хвостом: иначе после перезагрузки окна вставка и мышь не работают.
      const modes = new DecModes();
      const saved = memory.modesOf(pane.doc);
      if (saved) modes.feed(encoder.encode(saved));
      pane.modes = modes;
      term.write(modes.restore() + uiTerm.backlog);
      modes.feed(encoder.encode(uiTerm.backlog));
      saveModes(pane);
      pane.subscriptions.push(
        uiTerm.onData((chunk) => {
          modes.feed(encoder.encode(chunk));
          if (chunk.includes('[?')) saveModes(pane);
          gate.push(pane, chunk);
        }),
        uiTerm.onExit((exit) => {
          gate.flush(pane);
          pane.exitCode = exit.code;
          void refresh();
        }),
      );
      if (pane.doc === active) {
        term.fit();
        const { cols, rows } = term.size();
        void uiTerm.resize(cols, rows).catch(() => undefined);
        term.focus();
      }
    } catch (error) {
      fail('Терминал сессии не открылся', error);
    } finally {
      pane.attaching = false;
    }
  }

  // ---------- перечитывание вкладок ----------
  let refreshing: Promise<void> | undefined;
  let again = false;
  function refresh(): Promise<void> {
    if (refreshing) {
      again = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        again = false;
        await sync();
      } while (again && !disposed);
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  async function sync(): Promise<void> {
    let tabs: TabInfo[];
    try {
      tabs = (await run('sessions.tabs')) as TabInfo[];
    } catch {
      return;
    }
    if (disposed) return;
    const docs = tabs.map((t) => t.doc);
    for (const [doc, pane] of panes) {
      if (docs.includes(doc)) continue;
      detach(pane);
      pane.term?.dispose();
      pane.tab.remove();
      pane.body.remove();
      panes.delete(doc);
    }
    for (const info of tabs) {
      const known = panes.get(info.doc);
      if (known) {
        known.info = info;
        describeTab(known);
        if (known.attached !== null && known.attached !== info.sessionId) {
          // Сессия вкладки сменилась (восстановление): прежний терминал не нужен.
          detach(known);
          known.term?.dispose();
          known.term = undefined;
          known.attached = null;
          known.host.replaceChildren();
        }
      } else {
        const pane = makePane(info);
        panes.set(info.doc, pane);
      }
    }
    order = applyOrder(order.length ? order : memory.order, docs);
    strip.append(...order.map((doc) => panes.get(doc)?.tab).filter((t): t is HTMLElement => t !== undefined));
    memory.forget(docs);
    memory.setOrder(order);
    for (const pane of panes.values()) {
      showNotice(pane);
      void attach(pane);
    }
    if (active === null || !panes.has(active)) select(order[order.length - 1] ?? null);
    else select(active);
  }

  bindTabDrag(strip, (from, to) => {
    const fromDoc = [...panes.values()].find((p) => p.tab === from)?.doc;
    const toDoc = [...panes.values()].find((p) => p.tab === to)?.doc;
    if (fromDoc === undefined || toDoc === undefined) return;
    order = moveItem(order, order.indexOf(fromDoc), order.indexOf(toDoc));
    strip.append(...order.map((doc) => panes.get(doc)?.tab).filter((t): t is HTMLElement => t !== undefined));
    memory.setOrder(order);
  });

  // ---------- новая сессия ----------
  async function newSession(): Promise<void> {
    try {
      const projects = await ctx.contracts.get('cyborg.projects', 1);
      const project = await projects?.selected();
      if (!project || project.repos.length === 0) return void (await ask('Нет проекта', 'Выберите проект с репозиторием: сессия стартует в репозитории проекта.'));
      let repo = project.repos[0];
      if (project.repos.length > 1) {
        const items = repoLabels(project.repos).map((label, i) => ({ id: String(i), label }));
        const answer = await ctx.dialogs.show({ kind: 'menu', items, at: { x: 16, y: 40 } });
        if (answer === undefined) return;
        repo = project.repos[Number(answer)];
      }
      if (repo === undefined) return;
      const opened = (await run('sessions.create', { cwd: repo, addDirs: project.repos.filter((r) => r !== repo) })) as { sessionId: string };
      await refresh();
      const doc = [...panes.values()].find((p) => p.info.sessionId === opened.sessionId)?.doc;
      select(doc ?? active);
    } catch (error) {
      // Сессия не стартовала: причина названа, а не потеряна в консоли.
      fail('Сессия не открылась', error);
    }
  }
  create.addEventListener('click', () => void newSession());

  // ---------- размер шрифта ----------
  function setFontSize(size: number): void {
    if (size === fontSize) return;
    fontSize = size;
    memory.setFontSize(size);
    for (const pane of panes.values()) pane.term?.setFontSize(size);
    if (active !== null) panes.get(active)?.term?.fit();
  }
  // В capture до xterm: иначе колесо с клавишей команд прокрутит историю терминала.
  const wheelSteps = new WheelStepper();
  const onWheel = (event: Event): void => {
    const wheel = event as WheelEvent;
    if (!commandKey(wheel)) return;
    wheel.preventDefault();
    wheel.stopPropagation();
    setFontSize(stepFontSize(fontSize, wheelSteps.push(wheel.deltaY, wheel.timeStamp)));
  };
  root.addEventListener('wheel', onWheel, { capture: true, passive: false });

  // Размер экрана изменился - терминал и pty растут вместе с ним, иначе TUI займёт угол.
  const resized = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => active !== null && panes.get(active)?.term?.fit());
  resized?.observe(stage);

  const themed = ctx.theme.onChange((tokens) => {
    for (const pane of panes.values()) pane.term?.setTheme(tokens);
  });
  const pushed = ctx.channel.onMessage((message) => {
    const type = typeof message === 'object' && message !== null ? (message as { type?: unknown }).type : undefined;
    if (type === 'tabs') void refresh();
    else if (type === 'reveal') {
      const doc = (message as { doc?: unknown }).doc;
      void refresh().then(() => typeof doc === 'string' && select(doc));
    } else if (type === 'new-session') void newSession();
    else if (type === 'font-reset') setFontSize(DEFAULT_FONT_SIZE);
  });
  const visible = ctx.onVisibilityChange((shown) => {
    if (shown && active !== null) panes.get(active)?.term?.fit();
  });

  void refresh();
  return {
    dispose: () => {
      disposed = true;
      pushed.dispose();
      themed.dispose();
      visible.dispose();
      resized?.disconnect();
      root.removeEventListener('wheel', onWheel, { capture: true });
      for (const pane of panes.values()) {
        clearTimeout(pane.modesTimer);
        memory.setModes(pane.doc, pane.modes.restore());
        detach(pane);
        pane.term?.dispose();
      }
      panes.clear();
      root.replaceChildren();
    },
  };
}
