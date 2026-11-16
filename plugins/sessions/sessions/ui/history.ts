import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';
import { cy, el } from './dom.ts';
import { ago } from './ago.ts';
import { clickSelection, sessionsCount } from './selection.ts';
import { asMenuItem, bindList, rove } from './list-keys.ts';

// Вид «Сессии проекта» (FR-8001..8005): прошлые сессии репозиториев выбранного проекта - продолжить щелчком, выделить (Ctrl или Cmd + щелчок, Shift + щелчок, флажок),
// удалить одну (×, Delete) или несколько разом. Список собирает главная часть из истории агентов (`sessions.history.list`), удаляет агент (`history.delete`).
// Подтверждения и отказы - слой диалогов ядра, а не confirm и alert окна ai-cyborg. Управление с клавиатуры - list-keys.ts.

interface HistoryRow {
  readonly id: string;
  readonly repo: string;
  readonly agent: string;
  readonly title: string;
  readonly updated: number;
}
interface DeleteResult {
  readonly deleted: readonly string[];
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
}

const keyOf = (row: HistoryRow): string => `${row.agent}\0${row.repo}\0${row.id}`;
const basename = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface HistoryDeps {
  /** Клавиша команд нажата со щелчком: Cmd на macOS, Ctrl вне него. */
  readonly commandKey?: (event: { ctrlKey: boolean; metaKey: boolean }) => boolean;
  readonly now?: () => number;
}

export function mountHistory(root: HTMLElement, ctx: UiContext, deps: HistoryDeps = {}): Disposable {
  const commandKey = deps.commandKey ?? ((event) => (/Mac/i.test(navigator.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey));
  const now = deps.now ?? Date.now;
  const run = (command: string, ...args: unknown[]): Promise<unknown> => ctx.commands.run(command, ...args);
  const ask = (title: string, message: string, confirm?: string): Promise<boolean> =>
    ctx.dialogs
      .show({ kind: 'ask', title, message, buttons: confirm ? [{ id: 'yes', label: confirm }, { id: 'no', label: 'Отмена' }] : [{ id: 'ok', label: 'Закрыть' }] })
      .then((answer) => answer === 'yes' || answer === 'ok');

  const note = el('p', { id: 'note', textContent: 'Загрузка…' });
  const count = el('span', { id: 'count' });
  const selectAll = cy('cy-button', { id: 'select-all', textContent: 'Все' });
  const removeSelected = cy('cy-button', { id: 'remove-selected', textContent: 'Удалить' });
  removeSelected.setAttribute('variant', 'danger');
  const cancel = cy('cy-button', { id: 'cancel', textContent: 'Отмена' });
  const selectionBar = el('div', { id: 'selection' });
  selectionBar.hidden = true;
  selectionBar.append(count, selectAll, removeSelected, cancel);
  const reload = cy('cy-button', { id: 'reload', textContent: 'Обновить' });
  const list = el('div', { id: 'history' });
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Прошлые сессии');
  list.setAttribute('aria-multiselectable', 'true');
  bindList(list, '.history-item');
  const sheet = el('link', { rel: 'stylesheet', href: new URL('./ui.css', import.meta.url).href });
  root.append(sheet, reload, selectionBar, note, list);

  let project: { id: string; name: string; repos: readonly string[] } | null = null;
  let rows: HistoryRow[] = [];
  const items = new Map<string, { row: HistoryRow; item: HTMLElement; check: HTMLElement & { checked?: boolean } }>();
  let selected = new Set<string>();
  let anchor: string | null = null;
  let disposed = false;

  const sync = (): void => {
    selectionBar.hidden = selected.size === 0;
    count.textContent = `Выбрано: ${String(selected.size)}`;
    for (const [key, { item, check }] of items) {
      const on = selected.has(key);
      item.setAttribute('aria-selected', String(on));
      item.setAttribute('data-selected', String(on));
      check.checked = on;
    }
  };
  const pick = (key: string, mode: 'toggle' | 'range'): void => {
    selected = clickSelection([...items.keys()], selected, anchor, key, mode);
    anchor = key;
    sync();
  };
  const clear = (): void => {
    selected = new Set();
    anchor = null;
    sync();
  };

  const remove = async (targets: readonly HistoryRow[]): Promise<void> => {
    const failed: string[] = [];
    const byAgent = new Map<string, HistoryRow[]>();
    for (const row of targets) byAgent.set(`${row.agent}\0${row.repo}`, [...(byAgent.get(`${row.agent}\0${row.repo}`) ?? []), row]);
    for (const group of byAgent.values()) {
      const [first] = group;
      if (!first || !project) continue;
      try {
        const result = (await run('sessions.history.delete', project.id, first.repo, group.map((r) => r.id), first.agent)) as DeleteResult;
        for (const id of result.deleted) rows = rows.filter((r) => !(r.id === id && r.repo === first.repo && r.agent === first.agent));
        for (const f of result.failed) failed.push(`«${group.find((r) => r.id === f.id)?.title ?? f.id}»: ${f.reason}`);
      } catch (error) {
        failed.push(...group.map((r) => `«${r.title}»: ${messageOf(error)}`));
      }
    }
    selected = new Set([...selected].filter((key) => rows.some((r) => keyOf(r) === key)));
    render();
    if (failed.length) await ask('Не удалось удалить', failed.join('\n'));
  };
  const removeOne = async (row: HistoryRow): Promise<void> => {
    if (await ask('Удалить сессию', `Удалить сессию «${row.title}»? Её журнал будет стёрт, продолжить её станет нельзя.`, 'Удалить')) await remove([row]);
  };
  const removeMany = async (): Promise<void> => {
    const targets = rows.filter((r) => selected.has(keyOf(r)));
    if (!targets.length) return;
    if (await ask('Удалить сессии', `Удалить ${sessionsCount(targets.length)}? Журналы будут стёрты, продолжить эти сессии станет нельзя.`, 'Удалить')) await remove(targets);
  };
  const resume = async (row: HistoryRow): Promise<void> => {
    if (!project) return;
    try {
      await run('sessions.resume', { cwd: row.repo, addDirs: project.repos.filter((r) => r !== row.repo), resumeId: row.id, agent: row.agent });
    } catch (error) {
      await ask('Сессия не продолжена', messageOf(error));
    }
  };

  selectAll.addEventListener('click', () => {
    selected = new Set(items.keys());
    sync();
  });
  removeSelected.addEventListener('click', () => void removeMany());
  cancel.addEventListener('click', clear);
  reload.addEventListener('click', () => void load());

  function render(): void {
    items.clear();
    const nodes: HTMLElement[] = [];
    for (const row of rows) {
      const key = keyOf(row);
      const item = asMenuItem(el('div', { className: 'menu-item history-item' }), 'option');
      item.title = `Продолжить: ${row.title}\nВыделить: Ctrl или Cmd + щелчок, диапазон: Shift + щелчок`;
      const check = el('input', { type: 'checkbox', className: 'history-check', title: 'Выделить', tabIndex: -1 });
      check.addEventListener('click', (event) => {
        (event as Event).stopPropagation();
        pick(key, (event as MouseEvent).shiftKey ? 'range' : 'toggle');
      });
      const del = el('button', { className: 'close', textContent: '×', title: 'Удалить сессию (Delete)', tabIndex: -1 });
      del.addEventListener('click', (event) => {
        (event as Event).stopPropagation();
        void removeOne(row);
      });
      item.append(check, el('span', { className: 'history-title', textContent: row.title }), el('span', { className: 'repo-path', textContent: `${basename(row.repo)} · ${ago(row.updated, now())}` }), del);
      item.addEventListener('click', (event) => {
        const e = event as MouseEvent;
        // Пока что-то выделено, щелчок продолжает выделять: продолжить сессию случайно посреди отбора нельзя.
        if (e.shiftKey) pick(key, 'range');
        else if (commandKey(e) || selected.size) pick(key, 'toggle');
        else void resume(row);
      });
      item.addEventListener('keydown', (event) => {
        const e = event as KeyboardEvent;
        if (e.target !== item) return;
        if (e.key === 'Delete') {
          e.preventDefault();
          if (selected.size) void removeMany();
          else void removeOne(row);
        } else if (e.key === 'Escape' && selected.size) {
          e.preventDefault();
          clear();
        }
      });
      items.set(key, { row, item, check });
      nodes.push(item);
    }
    list.replaceChildren(...nodes);
    note.textContent = !project ? 'Нет проекта' : rows.length === 0 ? 'Прошлых сессий нет' : '';
    note.hidden = note.textContent === '';
    sync();
    rove(list, '.history-item');
  }

  async function load(): Promise<void> {
    try {
      const projects = await ctx.contracts.get('cyborg.projects', 1);
      const selectedProject = await projects?.selected();
      if (disposed) return;
      project = selectedProject ? { id: selectedProject.id, name: selectedProject.name, repos: selectedProject.repos } : null;
      rows = project ? ((await run('sessions.history.list', project.id)) as HistoryRow[]) : [];
      if (disposed) return;
      selected = new Set([...selected].filter((key) => rows.some((r) => keyOf(r) === key)));
      render();
    } catch (error) {
      note.textContent = messageOf(error);
      note.hidden = false;
    }
  }

  const pushed = ctx.channel.onMessage(() => void load());
  const visible = ctx.onVisibilityChange((shown) => shown && void load());
  void load();
  return {
    dispose: () => {
      disposed = true;
      pushed.dispose();
      visible.dispose();
      root.replaceChildren();
    },
  };
}

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  return mountHistory(root, ctx);
}

mount satisfies UiModule<HTMLElement>['mount'];
