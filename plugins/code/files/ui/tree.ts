import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';
import type { BranchList, RootView, ViewEntry, ViewReply } from '../protocol.ts';
import { cy, el } from './dom.ts';
import { asMenuItem, bindList, rove } from './list-keys.ts';
import { bindTree, markItem, replaceTree } from './tree-dom.ts';
import { rowKey } from './tree-keys.ts';

// Вид «Дерево»: корни, каталоги и файлы области (проект или сессия), отметки git, ветка корня и её смена. Данные у главной части (`files.view`): она держит слежение за деревом и сообщает виду,
// что состояние изменилось; вид только рисует и просит раскрыть, свернуть, открыть. Дерево управляется с клавиатуры (WAI-ARIA tree, tree-keys.ts), меню ветки - стрелками (list-keys.ts).

const LETTER: Readonly<Record<string, string>> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflict: '!', changed: '•' };
const LABEL: Readonly<Record<string, string>> = {
  modified: 'изменён',
  added: 'добавлен',
  deleted: 'удалён',
  renamed: 'переименован',
  untracked: 'не отслеживается',
  conflict: 'конфликт',
  changed: 'внутри есть изменения',
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Строка дерева как источник перетаскивания (FR-3001): перетаскивание ведёт ядро (`ctx.drag`), Chromium не пускает его из фрейма в фрейм другого процесса. */
export function makeDraggable(row: HTMLElement, path: string, ctx: Pick<UiContext, 'drag'>): void {
  row.draggable = true;
  row.addEventListener('dragstart', (event) => {
    event.preventDefault();
    ctx.drag.start(path);
  });
}

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  const sheet = el('link', { rel: 'stylesheet', href: new URL('./tree.css', import.meta.url).href });
  const scopes = cy('cy-tabs', { id: 'scopes' }) as HTMLElement & { tabs: unknown; selected: string | undefined };
  scopes.setAttribute('label', 'Область дерева');
  scopes.hidden = true;
  const refresh = cy('cy-button', { id: 'refresh', textContent: 'Обновить' });
  refresh.title = 'Перечитать дерево и отметки';
  const bar = el('div', { id: 'bar' });
  bar.append(scopes, refresh);
  const hint = el('p', { id: 'hint' });
  hint.hidden = true;
  const error = el('p', { id: 'error' });
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const tree = el('div', { id: 'tree' });
  bindTree(tree, 'Файлы');
  const menu = el('div', { id: 'branch-menu' });
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  root.append(sheet, bar, hint, error, tree, menu);
  /** Кнопка, с которой открыто меню ветки: Escape возвращает фокус на неё. */
  let menuAnchor: HTMLElement | null = null;
  bindList(menu, '.menu-item');
  menu.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') closeMenu(menuAnchor);
  });

  /** Что человек выбрал сам: область (пусто - по умолчанию) и открытый файл. */
  let pinned = '';
  let selected: string | null = null;
  let reply: ViewReply | null = null;
  let epoch = -1;
  let applied = -1;
  let disposed = false;

  const fail = (e: unknown): void => {
    error.textContent = messageOf(e);
    error.hidden = false;
  };
  const ok = (): void => {
    error.hidden = true;
  };

  /** Ответ старее показанного (запрос ушёл раньше клика, а вернулся позже) отбрасывается; равная версия - то же состояние. */
  function apply(next: ViewReply): void {
    if (disposed) return;
    if (next.epoch === epoch && next.version < applied) return;
    const same = next.epoch === epoch && next.version === applied;
    epoch = next.epoch;
    applied = next.version;
    reply = next;
    if (pinned !== '' && next.scope !== pinned) pinned = '';
    if (!same) render(next);
  }

  async function call(command: string, ...args: unknown[]): Promise<unknown> {
    try {
      const value = await ctx.commands.run(command, ...args);
      ok();
      return value;
    } catch (e) {
      fail(e);
      return undefined;
    }
  }

  async function reload(forced = false): Promise<void> {
    const value = (await call('files.view', pinned, forced)) as ViewReply | undefined;
    if (value) apply(value);
  }

  async function act(command: string, path: string): Promise<void> {
    const value = (await call(command, path)) as ViewReply | undefined;
    if (value) apply(value);
    // Отказ (каталог исчез, область сменилась) - вид перечитывает, а не остаётся на устаревшем.
    else void reload();
  }

  // ---------- рисование ----------

  function render(r: ViewReply): void {
    // Вкладки областей есть, только когда выбирать есть из чего.
    scopes.hidden = r.scopes.length < 2;
    scopes.tabs = r.scopes.map((s) => ({ id: s.id, label: s.label }));
    scopes.selected = r.scope;
    hint.hidden = r.hint === null;
    hint.textContent = r.hint ?? '';
    const fragment = document.createDocumentFragment();
    for (const rootView of r.roots) {
      fragment.append(rootRow(rootView));
      if (!rootView.collapsed && rootView.error === null) renderDir(rootView, rootView.path, '', 1, fragment);
    }
    replaceTree(tree, fragment);
  }

  function twisty(sign: string): HTMLElement {
    const t = el('span', { className: 'twisty', textContent: sign });
    t.setAttribute('aria-hidden', 'true');
    return t;
  }

  function rootRow(rootView: RootView): HTMLElement {
    const row = el('div', { className: `row root${rootView === reply?.roots[0] ? ' primary' : ''}` });
    row.title = `${rootView.path}\n${rootView.hint}`;
    markItem(row, rowKey(rootView.path, ''), 1, !rootView.collapsed, null);
    makeDraggable(row, rootView.path, ctx);
    row.append(twisty(rootView.collapsed ? '▸' : '▾'), el('span', { className: 'name', textContent: rootView.label }));
    const meta = el('span', { className: 'meta' });
    if (rootView.error !== null) {
      const failed = el('span', { className: 'problem', textContent: 'не прочитан' });
      failed.title = rootView.error;
      meta.append(failed);
    } else if (rootView.branch === null) {
      meta.append(el('span', { textContent: 'не git' }));
    } else if (rootView.switchable) {
      const branch = el('button', { className: 'branch', textContent: `⎇ ${rootView.branch}` });
      branch.title = 'Сменить ветку';
      branch.addEventListener('click', (event) => {
        event.stopPropagation();
        void openBranchMenu(rootView, branch);
      });
      meta.append(branch);
    } else {
      const branch = el('span', { textContent: `⎇ ${rootView.branch}` });
      branch.title = 'Веткой управляет сессия Claude';
      meta.append(branch);
    }
    if (rootView.changes > 0) meta.append(el('span', { className: 'changes', textContent: `  ±${rootView.changes}` }));
    if (rootView.notice !== null) {
      const notice = el('span', { className: 'notice', textContent: ' ⚠' });
      notice.title = rootView.notice;
      meta.append(notice);
    }
    row.append(meta);
    row.addEventListener('click', () => void act('files.toggle-root', rootView.path));
    return row;
  }

  function renderDir(rootView: RootView, dir: string, rel: string, depth: number, into: DocumentFragment): void {
    const entries: readonly ViewEntry[] | undefined = rootView.nodes[dir];
    if (entries === undefined) return;
    for (const [name, kind, mark, link] of entries) {
      const childRel = rel ? `${rel}/${name}` : name;
      const abs = `${dir}/${name}`;
      const isDir = kind === 'dir';
      const expanded = isDir && rootView.nodes[abs] !== undefined;
      const row = el('div', { className: `row ${isDir ? 'dir' : kind === 'link' || kind === 'other' ? 'other' : 'file'}` });
      row.style.paddingLeft = `${4 + depth * 12}px`;
      row.title = kind === 'link' ? `${abs}\nссылка: цель недоступна` : abs;
      markItem(row, rowKey(rootView.path, childRel), depth + 1, isDir ? expanded : null, isDir ? null : selected === abs);
      makeDraggable(row, abs, ctx);
      const label = el('span', { className: 'name', textContent: name });
      row.append(twisty(isDir ? (expanded ? '▾' : '▸') : ''), label);
      if (mark !== null) {
        label.classList.add(`st-${mark}`);
        const badge = el('span', { className: `badge st-${mark}`, textContent: LETTER[mark] ?? '' });
        badge.title = LABEL[mark] ?? mark;
        row.append(badge);
        if (mark === 'changed') row.classList.add('has-changes');
      }
      if (link && kind !== 'dir') row.classList.add('link');
      if (selected === abs) row.classList.add('selected');
      row.addEventListener('click', () => {
        if (isDir) {
          void act(expanded ? 'files.collapse' : 'files.expand', abs);
        } else if (kind === 'file') {
          selected = abs;
          for (const other of tree.querySelectorAll<HTMLElement>('.row.selected')) {
            other.classList.remove('selected');
            other.setAttribute('aria-selected', 'false');
          }
          row.classList.add('selected');
          row.setAttribute('aria-selected', 'true');
          void call('files.open', abs);
        }
      });
      into.append(row);
      if (expanded) renderDir(rootView, abs, childRel, depth + 1, into);
    }
  }

  // ---------- меню ветки (FR-7005) ----------

  function closeMenu(restoreFocus: HTMLElement | null): void {
    menu.hidden = true;
    menu.replaceChildren();
    if (restoreFocus?.isConnected) restoreFocus.focus();
  }

  async function openBranchMenu(rootView: RootView, anchor: HTMLElement): Promise<void> {
    const title = el('div', { className: 'menu-title', textContent: `Ветка ${rootView.label}` });
    const filter = el('input', { className: 'menu-filter', placeholder: 'Найти ветку' });
    const problem = el('div', { className: 'menu-error' });
    problem.setAttribute('role', 'alert');
    problem.hidden = true;
    const list = el('div', { className: 'branch-list' });
    menu.setAttribute('aria-label', `Ветка ${rootView.label}`);
    menu.replaceChildren(title, filter, problem, list);
    menu.hidden = false;
    const say = (text: string): void => {
      problem.textContent = text;
      problem.hidden = false;
    };
    let branches: BranchList;
    try {
      branches = (await ctx.commands.run('files.branches', rootView.path)) as BranchList;
    } catch (e) {
      say(messageOf(e));
      return;
    }
    const all = [...branches.local.map((name) => ({ name, remote: false })), ...branches.remote.map((name) => ({ name, remote: true }))];
    let shown = all;
    const pick = async (name: string): Promise<void> => {
      if (name === branches.current) return;
      let result: { error?: string };
      try {
        result = (await ctx.commands.run('files.switch', rootView.path, name)) as { error?: string };
      } catch (e) {
        say(`Ветка не сменилась: ${messageOf(e)}`);
        return;
      }
      if (result.error) {
        say(`Ветка не сменилась: ${result.error}`);
        return;
      }
      closeMenu(null);
      void reload(true);
    };
    const draw = (): void => {
      const query = filter.value.trim().toLowerCase();
      shown = all.filter((b) => b.name.toLowerCase().includes(query));
      list.replaceChildren(
        ...shown.slice(0, 200).map(({ name, remote }) => {
          const item = asMenuItem(el('div', { className: `menu-item branch-item${name === branches.current ? ' current' : ''}` }), 'menuitemradio');
          item.setAttribute('aria-checked', String(name === branches.current));
          item.append(el('span', { textContent: `${name === branches.current ? '✓ ' : ''}${name}` }));
          if (remote) item.append(el('span', { className: 'repo-path', textContent: 'только на сервере' }));
          item.addEventListener('click', () => void pick(name));
          return item;
        }),
      );
      if (shown.length === 0) list.append(el('div', { className: 'menu-title', textContent: 'Нет веток' }));
      rove(list, '.menu-item');
    };
    filter.addEventListener('input', draw);
    filter.addEventListener('keydown', (event) => {
      const e = event as KeyboardEvent;
      if (e.key === 'Enter' && shown[0]) void pick(shown[0].name);
    });
    menuAnchor = anchor;
    draw();
    filter.focus();
  }

  // ---------- события ----------

  scopes.addEventListener('cy-select', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail.id;
    pinned = id === reply?.auto ? '' : id;
    void reload();
  });
  refresh.addEventListener('click', () => void reload(true));
  const channel = ctx.channel.onMessage(() => void reload());
  const visible = ctx.onVisibilityChange((v) => {
    // Скрытый вид событий не теряет, но окно могло долго не получать их от ОС: показ перечитывает всё.
    if (v) void reload(true);
  });
  void reload();
  return {
    dispose: () => {
      disposed = true;
      channel.dispose();
      visible.dispose();
      root.replaceChildren();
    },
  };
}

mount satisfies UiModule<HTMLElement>['mount'];
