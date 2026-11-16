// Журнал Claude Code не знает, кто открыл сессию: «История» помечает дочерние по этому перечню. Перенос src/main/child-sessions.ts ai-cyborg:
// файл `child-sessions.json` в каталоге данных плагина, последние 2000 номеров разговоров. Запись - через шлюз `ctx.os.fs` (атомарно, права не нужно).

const LIMIT = 2000;
/** Номер разговора Claude Code: UUID. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isSessionId = (value: unknown): value is string => typeof value === 'string' && SESSION_ID.test(value);

/** То, что нужно от `ctx.os.fs`. */
export interface TextFiles {
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
}

/** Номера разговоров Claude Code, открытых другой сессией (open_session, spawn_agent). */
export class ChildSessions {
  readonly file: string;
  private readonly fs: TextFiles;
  private queue: Promise<void> = Promise.resolve();

  constructor(file: string, fs: TextFiles) {
    this.file = file;
    this.fs = fs;
  }

  private async read(): Promise<string[]> {
    try {
      const data: unknown = JSON.parse(await this.fs.readText(this.file));
      return Array.isArray(data) ? data.filter(isSessionId) : [];
    } catch {
      return [];
    }
  }

  /** Запись по очереди: «прочитал - изменил - записал» двух вызовов подряд не теряет номер. Ошибка записи - в `onError`, плагин не падает. */
  add(id: string, onError: (error: unknown) => void = () => undefined): Promise<void> {
    if (!isSessionId(id)) return Promise.resolve();
    this.queue = this.queue.then(async () => {
      const ids = (await this.read()).filter((x) => x !== id);
      ids.push(id);
      try {
        await this.fs.writeText(this.file, JSON.stringify(ids.slice(-LIMIT)));
      } catch (error) {
        onError(error);
      }
    });
    return this.queue;
  }

  async all(): Promise<Set<string>> {
    await this.queue;
    return new Set(await this.read());
  }
}
