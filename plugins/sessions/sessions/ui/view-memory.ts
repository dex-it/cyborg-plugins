import type { UiContext } from '@cyborg-harness/contracts';
import { parseFontSize } from './font-size.ts';

// Память вида: ключи `localStorage` окна ai-cyborg (prefs.ts) переехали в `ctx.state` - состояние воркспейса, у каждого воркспейса своя.
// Память недоступна или не записывается - настройка действует до закрытия вида (как при недоступном `localStorage`).
// Что лежит: `fontSize` (ключ `cyborg.fontSize`), `order` (порядок вкладок по документам), `modes` (режимы DEC терминала по документам, см. term-modes.ts).

export interface ViewMemoryData {
  readonly fontSize: number;
  readonly order: readonly string[];
  readonly modes: Readonly<Record<string, string>>;
}

const MAX_TABS = 200;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Что вид помнил: негодная форма даёт значения по умолчанию, лишнее отбрасывается. */
export function readMemory(raw: unknown): ViewMemoryData {
  const data = isRecord(raw) ? raw : {};
  const order = Array.isArray(data.order) ? data.order.filter((x): x is string => typeof x === 'string').slice(0, MAX_TABS) : [];
  const modes: Record<string, string> = {};
  if (isRecord(data.modes)) for (const [doc, text] of Object.entries(data.modes).slice(0, MAX_TABS)) if (typeof text === 'string' && text.length <= 512) modes[doc] = text;
  return { fontSize: parseFontSize(data.fontSize), order, modes };
}

/** Порядок вкладок: сохранённый порядок для знакомых документов, новые - в конец в порядке появления. */
export function applyOrder(saved: readonly string[], docs: readonly string[]): string[] {
  const known = saved.filter((d) => docs.includes(d));
  return [...known, ...docs.filter((d) => !known.includes(d))];
}

export class ViewMemory {
  private data: ViewMemoryData;
  private readonly state: UiContext['state'];
  private pending: Promise<void> = Promise.resolve();

  constructor(state: UiContext['state']) {
    this.state = state;
    this.data = readMemory(state.value);
  }

  get fontSize(): number {
    return this.data.fontSize;
  }
  get order(): readonly string[] {
    return this.data.order;
  }
  modesOf(doc: string): string {
    return this.data.modes[doc] ?? '';
  }

  /** Записи идут по очереди и не бросают: отказ памяти не ломает вид. */
  private save(next: ViewMemoryData): void {
    this.data = next;
    this.pending = this.pending.then(() => this.state.set(next).catch(() => undefined));
  }

  setFontSize(size: number): void {
    if (size !== this.data.fontSize) this.save({ ...this.data, fontSize: size });
  }
  setOrder(order: readonly string[]): void {
    if (order.join('\0') !== this.data.order.join('\0')) this.save({ ...this.data, order: order.slice(0, MAX_TABS) });
  }
  setModes(doc: string, text: string): void {
    if ((this.data.modes[doc] ?? '') === text) return;
    const modes = { ...this.data.modes };
    if (text) modes[doc] = text;
    else delete modes[doc];
    this.save({ ...this.data, modes });
  }
  /** Вкладки закрыты: их режимы и место в порядке забываются. */
  forget(docs: readonly string[]): void {
    const alive = new Set(docs);
    const modes = Object.fromEntries(Object.entries(this.data.modes).filter(([doc]) => alive.has(doc)));
    const order = this.data.order.filter((doc) => alive.has(doc));
    if (Object.keys(modes).length !== Object.keys(this.data.modes).length || order.length !== this.data.order.length) this.save({ ...this.data, modes, order });
  }
  /** Дождаться записи (для теста и для dispose). */
  flush(): Promise<void> {
    return this.pending;
  }
}
