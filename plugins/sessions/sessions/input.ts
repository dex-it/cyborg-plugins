import { cleanMessage, MAX_INPUT_LENGTH, validateInputArgs, validateResizeArgs, validateSessionId } from './args.ts';
import type { Registry } from './registry.ts';

// Ввод, размер и завершение сессии, идущие через плагин. Вид пишет в терминал напрямую по билету (каналы `session:input`, `session:resize` решает pty-хост ядра),
// а команды, члены контракта `send` и `paste` и чужие плагины приходят сюда: аргументы проверяются так же, как проверял главный процесс ai-cyborg (session-args.ts).
// Запись в pty завершённого процесса бросает: ошибку принимает вызывающий, плагин не падает (`guarded` в sessions.ts).

/** Пауза между текстом и Enter, как у кнопок команд (command-bar.ts): пакет «текст и Enter» TUI вправе принять за вставку. */
export const SUBMIT_DELAY_MS = 150;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface Input {
  /** Ввод как с клавиатуры. Негодные аргументы и сессия, которой нет, - молча ничего (мусор из вида не роняет плагин). */
  write(id: unknown, data: unknown): Promise<void>;
  resize(id: unknown, cols: unknown, rows: unknown): Promise<void>;
  kill(id: unknown): Promise<void>;
  /** Контракт: `send` и `paste` отказывают с причиной, а не молчат: вызывающий плагин должен знать, что текст не дошёл. */
  send(sessionId: unknown, text: unknown): Promise<void>;
  paste(sessionId: unknown, text: unknown, submit: boolean): Promise<void>;
}

export function createInput(registry: Registry): Input {
  const handleOf = (id: string) => registry.live(id)?.handle;

  async function guarded(id: string, action: (h: NonNullable<ReturnType<typeof handleOf>>) => Promise<void>): Promise<void> {
    const handle = handleOf(id);
    if (!handle) return;
    try {
      await action(handle);
    } catch {
      // Процесс уже завершён: выход уберёт сессию.
    }
  }

  function strict(sessionId: unknown, text: unknown, limit: number) {
    const id = validateSessionId(sessionId);
    if (id === null) throw new Error('id сессии не годится');
    if (typeof text !== 'string') throw new Error('текст не строка');
    if (text.length > limit) throw new Error(`текст длиннее ${String(limit)} знаков: он не отправлен`);
    const handle = handleOf(id);
    if (!handle) throw new Error(`сессия ${id} завершилась или её нет`);
    return { id, handle };
  }

  return {
    async write(id, data) {
      const args = validateInputArgs(id, data);
      if (args) await guarded(args.id, (h) => h.write(args.data));
    },
    async resize(id, cols, rows) {
      const args = validateResizeArgs(id, cols, rows);
      if (args) await guarded(args.id, (h) => h.resize(args.cols, args.rows));
    },
    async kill(id) {
      const valid = validateSessionId(id);
      if (valid !== null) await guarded(valid, (h) => h.kill());
    },
    async send(sessionId, text) {
      const { handle } = strict(sessionId, text, MAX_INPUT_LENGTH);
      try {
        await handle.write(text as string);
      } catch {
        throw new Error(`сессия ${String(sessionId)} завершилась`);
      }
    },
    async paste(sessionId, text, submit) {
      // Вставкой: перевод строки в тексте TUI мог бы принять за Enter и отправить сообщение по кускам. Чистка до предела: вставка от чужого плагина не закроет себя ESC.
      const { id, handle } = strict(sessionId, text, MAX_INPUT_LENGTH);
      const clean = cleanMessage(text as string);
      try {
        await handle.write(`\x1b[200~${clean}\x1b[201~`);
        if (!submit) return;
        // Enter отдельной записью и перед ней проверка: сессия могла выйти за паузу.
        await wait(SUBMIT_DELAY_MS);
        if (!handleOf(id)) throw new Error('завершилась');
        await handle.write('\r');
      } catch {
        throw new Error(`сессия ${id} завершилась${submit ? ': Enter не отправлен' : ''}`);
      }
    },
  };
}
