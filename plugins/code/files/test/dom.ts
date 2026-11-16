// Минимальный DOM для тестов видов: вид живёт во фрейме окна, а тест идёт в Node. Подменено только то, что трогает вид «Дерево»:
// дерево, фрагмент, события с всплытием, классы, атрибуты, dataset, фокус (`activeElement`, `focusin`), `closest`, `matches` и `querySelectorAll` по простым селекторам.
// Настоящий фрейм, CSP и элементы cy-* проверяет окно приложения.

export interface FakeEvent {
  readonly type: string;
  readonly target: FakeElement;
  prevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  [key: string]: unknown;
}
type Handler = (event: FakeEvent) => void;

const FRAGMENT = '#FRAGMENT';
const doc: { activeElement: FakeElement | null } = { activeElement: null };

/** Простые селекторы: `[role="treeitem"]`, `.класс`, `.класс.другой`, `тег`. */
function matches(element: FakeElement, selector: string): boolean {
  const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector);
  if (attr) return element.getAttribute(attr[1] ?? '') === attr[2];
  if (selector.startsWith('.')) return selector.slice(1).split('.').every((c) => element.className.split(/\s+/).includes(c));
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

export class FakeElement {
  readonly tagName: string;
  id = '';
  className = '';
  textContent = '';
  title = '';
  hidden = false;
  disabled = false;
  draggable = false;
  tabIndex = 0;
  scrollTop = 0;
  placeholder = '';
  value = '';
  rel = '';
  href = '';
  /** Свойства элементов ядра (`cy-tabs`: tabs, selected). */
  tabs: unknown = undefined;
  selected: string | undefined = undefined;
  dataset: Record<string, string> = {};
  /** Корень, смонтированный тестом: цепочка родителей, доходящая до него, - «в документе». */
  mounted = false;
  parent: FakeElement | undefined;
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  focused = 0;
  clicks = 0;
  readonly style = { paddingLeft: '' };
  readonly classList = {
    add: (c: string) => void this.toggleClass(c, true),
    remove: (c: string) => void this.toggleClass(c, false),
    toggle: (c: string, on?: boolean) => void this.toggleClass(c, on ?? !this.className.split(/\s+/).includes(c)),
    contains: (c: string) => this.className.split(/\s+/).includes(c),
  };
  private readonly listeners = new Map<string, Handler[]>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  private toggleClass(c: string, on: boolean): void {
    const set = new Set(this.className.split(/\s+/).filter(Boolean));
    if (on) set.add(c);
    else set.delete(c);
    this.className = [...set].join(' ');
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  matches(selector: string): boolean {
    return matches(this, selector);
  }
  get isConnected(): boolean {
    for (let e: FakeElement | undefined = this; e; e = e.parent) if (e.mounted) return true;
    return false;
  }
  addEventListener(type: string, handler: Handler): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  removeEventListener(type: string, handler: Handler): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((h) => h !== handler));
  }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      if (node.tagName === FRAGMENT) {
        const inner = node.children;
        node.children = [];
        this.append(...inner);
        continue;
      }
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parent = undefined;
    this.children = [];
    this.append(...nodes);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = undefined;
  }
  contains(node: FakeElement | null): boolean {
    return node !== null && (node === this || this.children.some((c) => c.contains(node)));
  }
  closest(selector: string): FakeElement | null {
    for (let e: FakeElement | undefined = this; e; e = e.parent) if (matches(e, selector)) return e;
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((c) => [...(matches(c, selector) ? [c] : []), ...c.querySelectorAll(selector)]);
  }
  focus(_options?: unknown): void {
    this.focused++;
    doc.activeElement = this;
    this.fire('focusin');
  }
  click(): void {
    this.clicks++;
    this.fire('click');
  }
  /** Событие на элементе с всплытием к родителям, как от настоящего DOM. */
  fire(type: string, extra: Record<string, unknown> = {}): FakeEvent {
    const event: FakeEvent = {
      type,
      target: this,
      prevented: false,
      stopped: false,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
      ...extra,
    };
    for (let e: FakeElement | undefined = this; e && !event.stopped; e = e.parent) for (const h of e.listeners.get(type) ?? []) h(event);
    return event;
  }
  /** Поиск по id в поддереве. */
  find(id: string): FakeElement {
    const found = this.findAll((e) => e.id === id)[0];
    if (!found) throw new Error(`элемента #${id} нет; есть: ${this.findAll(() => true).map((e) => e.id || e.className || e.tagName).join(', ')}`);
    return found;
  }
  findAll(match: (e: FakeElement) => boolean): FakeElement[] {
    return [...(match(this) ? [this] : []), ...this.children.flatMap((c) => c.findAll(match))];
  }
  byClass(name: string): FakeElement[] {
    return this.findAll((e) => e.classList.contains(name));
  }
}

/** Подменяет `document` на время `body`. */
export async function withDocument<T>(body: () => Promise<T>): Promise<T> {
  doc.activeElement = null;
  const document = {
    createElement: (tag: string) => new FakeElement(tag),
    createDocumentFragment: () => new FakeElement(FRAGMENT),
    hasFocus: () => true,
    get activeElement() {
      return doc.activeElement;
    },
  };
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  try {
    return await body();
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
  }
}

/** Ждёт условия, не гадая со временем. */
export async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`не дождались: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
