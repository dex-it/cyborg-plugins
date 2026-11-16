import { HANDOFF_TIMEOUT_MS, type HandoffRequest } from './tools.ts';

// Задача, переданная сессией в новую вкладку (ADR-0019 ai-cyborg, п. 4): вкладку открывают по одноразовому ключу, а промпт хранит плагин
// и отдаёт его только тому, кто назвал ключ и каталог. Перенос `Handoffs` из src/main/session-tools.ts.
//
// В ai-cyborg ключ шёл окну, и оно открывало вкладку командой `session:create`. На ядре документы-вкладки создаёт сам плагин `sessions`, поэтому
// «интерфейс» этой передачи - его собственный исполнитель (`send` в конструкторе): ключ и промпт не покидают плагин и до вида не доходят
// (решение 13 в docs/guide/development/decisions.md). Отказ открыть вкладку (`fail`) возвращается вызвавшей модели с причиной: это канал `session:handoffFailed`.

interface Pending extends HandoffRequest {
  prompt: string;
  resolve: (id: number) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Что отдаёт `take`: промпт и способ сообщить вызвавшей модели итог открытия. */
export type Taken = Pick<Pending, 'prompt' | 'from' | 'resolve' | 'reject'>;

export class Handoffs {
  private readonly pending = new Map<string, Pending>();
  private readonly send: (request: HandoffRequest) => boolean;
  private readonly timeoutMs: number;

  /** `send` получает ключ, номер поручившей и каталог, но не промпт. false - исполнителя нет, передавать некому. */
  constructor(send: (request: HandoffRequest) => boolean, timeoutMs = HANDOFF_TIMEOUT_MS) {
    this.send = send;
    this.timeoutMs = timeoutMs;
  }

  /** Номер новой сессии, когда вкладка открыта. */
  request(from: number, repo: string, prompt: string): Promise<number> {
    const hid = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(hid, `вкладка не открыта за ${String(this.timeoutMs / 1000)} с`), this.timeoutMs);
      this.pending.set(hid, { hid, from, repo, prompt, resolve, reject, timer });
      if (!this.send({ hid, from, repo })) this.fail(hid, 'открыть вкладку некому');
    });
  }

  /** Передача для открытия: ключ одноразовый, каталог - тот, что выбрала модель. */
  take(hid: unknown, cwd: unknown): Taken | null {
    const entry = typeof hid === 'string' ? this.pending.get(hid) : undefined;
    if (!entry || entry.repo !== cwd) return null;
    this.pending.delete(entry.hid);
    clearTimeout(entry.timer);
    return entry;
  }

  /** Вкладку открыть не удалось: причина (до 500 знаков) вернётся вызвавшей модели. */
  fail(hid: unknown, reason: unknown): void {
    const entry = typeof hid === 'string' ? this.pending.get(hid) : undefined;
    if (!entry) return;
    this.pending.delete(entry.hid);
    clearTimeout(entry.timer);
    entry.reject(new Error(typeof reason === 'string' && reason ? reason.slice(0, 500) : 'вкладка не открыта'));
  }

  get size(): number {
    return this.pending.size;
  }
}
