import { restoreIndex, tabStopIndex, treeKeyAction, type KeyRow } from './tree-keys.ts';

// Дерево как WAI-ARIA tree на плоском списке строк (`bindTree`, `replaceTree`, `markItem` из `src/renderer/tree.ts` ai-cyborg): роли, ключи строк, клавиши и возврат фокуса после перерисовки.

const ITEM = '[role="treeitem"]';

/** Роль и состояние строки для чтения с экрана; ключ нужен, чтобы после перерисовки найти ту же строку. */
export function markItem(row: HTMLElement, key: string, level: number, expanded: boolean | null, selected: boolean | null): void {
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(level));
  if (expanded !== null) row.setAttribute('aria-expanded', String(expanded));
  if (selected !== null) row.setAttribute('aria-selected', String(selected));
  row.dataset.key = key;
  // В порядке табуляции остаётся одна строка; replaceTree выбирает её после отрисовки.
  row.tabIndex = -1;
}

const itemOf = (node: EventTarget | Element | null): HTMLElement | null => (node as HTMLElement | null)?.closest?.<HTMLElement>(ITEM) ?? null;

const itemsOf = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(ITEM)];

function setTabStop(container: HTMLElement, row: HTMLElement): void {
  for (const item of itemsOf(container)) item.tabIndex = item === row ? 0 : -1;
}

/**
 * Дерево как WAI-ARIA tree: стрелки, Home и End переводят фокус, вправо и влево раскрывают и сворачивают, Enter и пробел
 * нажимают строку. Работает на контейнере: строки пересоздаются при каждой перерисовке.
 */
export function bindTree(container: HTMLElement, label: string): void {
  container.setAttribute('role', 'tree');
  container.setAttribute('aria-label', label);
  container.addEventListener('focusin', (event) => {
    const row = itemOf(event.target as Element);
    if (row && container.contains(row)) setTabStop(container, row);
  });
  container.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    // Кнопка ветки внутри строки корня и прочие вложенные элементы управляются сами.
    if (e.altKey || e.ctrlKey || e.metaKey || !(e.target as HTMLElement).matches?.(ITEM)) return;
    const items = itemsOf(container);
    const rows: KeyRow[] = items.map((item) => ({
      level: Number(item.getAttribute('aria-level')),
      expandable: item.hasAttribute('aria-expanded'),
      expanded: item.getAttribute('aria-expanded') === 'true',
    }));
    const action = treeKeyAction(e.key, rows, items.indexOf(e.target as HTMLElement));
    if (!action) return;
    e.preventDefault();
    if (action.kind === 'focus') items[action.index]?.focus();
    else if (action.kind === 'click') items[action.index]?.click();
  });
}

/** Подменяет строки дерева готовыми; прокрутка и фокус клавиатуры остаются там, где были (строка с тем же путём, иначе родитель, иначе первая). */
export function replaceTree(container: HTMLElement, fragment: DocumentFragment | HTMLElement): void {
  const scroll = container.scrollTop;
  const active = document.activeElement;
  const focused = active !== null && container.contains(active) ? itemOf(active) : null;
  const wanted = focused?.dataset.key ?? null;
  container.replaceChildren(fragment);
  container.scrollTop = scroll;
  const items = itemsOf(container);
  const stop = tabStopIndex(items.map((item) => item.getAttribute('aria-selected') === 'true'));
  const first = items[stop];
  if (first) first.tabIndex = 0;
  if (focused) items[restoreIndex(items.map((item) => item.dataset.key ?? ''), wanted)]?.focus({ preventScroll: true });
}
