// Минимальный DOM для тестов видов: вид живёт во фрейме окна, а тест идёт в Node. Подменено только то, что трогают виды `projects`;
// настоящий фрейм, CSP и элементы cy-* проверяет окно приложения (smoke), здесь - логика видов поверх настоящего ядра.

export type Handler = (event: FakeEvent) => void;
export interface FakeEvent {
  readonly type: string;
  readonly target: FakeElement;
  readonly detail?: unknown;
  readonly key?: string;
}

export class FakeElement {
  readonly tag: string;
  id = '';
  textContent = '';
  hidden = false;
  disabled = false;
  checked = false;
  value = '';
  items: unknown = undefined;
  selected: string | undefined = undefined;
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  private listeners = new Map<string, Handler[]>();
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type: string, handler: Handler): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  removeEventListener(type: string, handler: Handler): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((h) => h !== handler));
  }
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(): void {
    this.children = [];
  }
  /** Вызывает слушателей, как событие, пришедшее от элемента. */
  fire(type: string, extra: { detail?: unknown; key?: string } = {}): void {
    for (const h of this.listeners.get(type) ?? []) h({ type, target: this, ...extra });
  }
  /** Поиск по id в поддереве. */
  find(id: string): FakeElement {
    const found = this.findAll((e) => e.id === id)[0];
    if (!found) throw new Error(`элемента #${id} нет; есть: ${this.findAll(() => true).map((e) => e.id || e.tag).join(', ')}`);
    return found;
  }
  findAll(match: (e: FakeElement) => boolean): FakeElement[] {
    return [...(match(this) ? [this] : []), ...this.children.flatMap((c) => c.findAll(match))];
  }
}

/** Подменяет `document` на время `body`; клавиши документа доставляет `press`. */
export async function withDocument<T>(body: (doc: { press(key: string): void }) => Promise<T>): Promise<T> {
  const keys: Handler[] = [];
  const document = {
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: (type: string, h: Handler) => void (type === 'keydown' && keys.push(h)),
    removeEventListener: (type: string, h: Handler) => void (type === 'keydown' && keys.splice(keys.indexOf(h), 1)),
  };
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  try {
    return await body({ press: (key) => keys.slice().forEach((h) => h({ type: 'keydown', key, target: new FakeElement('document') })) });
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
  }
}

/** Ждёт условия, не гадая со временем. */
export async function until<T>(read: () => T | undefined | false, what: string, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`не дождались: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
