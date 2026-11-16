// Минимальный DOM для тестов видов: вид живёт во фрейме окна, а тест идёт в Node. Подменено только то, что трогают виды `sessions` (и модули вкладок и списков):
// дерево, события с всплытием, классы, атрибуты, `closest` и `querySelectorAll` по простым селекторам. Настоящий фрейм, CSP, xterm и элементы cy-* проверяет окно приложения.

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

/** Простые селекторы: `[role="tab"]`, `.класс`, `тег`. */
function matches(element: FakeElement, selector: string): boolean {
  const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector);
  if (attr) return element.getAttribute(attr[1] ?? '') === attr[2];
  if (selector.startsWith('.')) return element.className.split(/\s+/).includes(selector.slice(1));
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
  checked = false;
  tabIndex = 0;
  type = '';
  rel = '';
  href = '';
  value = '';
  items: unknown = undefined;
  parent: FakeElement | undefined;
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  focused = 0;
  clicks = 0;
  readonly styleVars = new Map<string, string>();
  readonly style = { setProperty: (name: string, value: string) => void this.styleVars.set(name, value) };
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
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  addEventListener(type: string, handler: Handler): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  removeEventListener(type: string, handler: Handler): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((h) => h !== handler));
  }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
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
  focus(): void {
    this.focused++;
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
  const document = { createElement: (tag: string) => new FakeElement(tag), hasFocus: () => true };
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
