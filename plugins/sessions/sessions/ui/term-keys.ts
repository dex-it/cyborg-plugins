// Клавиши терминала, которые вид забирает у xterm (createTerminal в app.ts ai-cyborg): Shift+Enter - перевод строки в запросе (FR-10003), копирование и вставка вне macOS.
// Решение вынесено из xterm-term.ts: сам xterm в Node не живёт, а правило нужно проверять.

export interface KeyInfo {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/** `pass: true` - клавиша идёт xterm как обычно; иначе xterm её не обрабатывает, а вид делает названное. */
export type KeyAction = { readonly pass: true } | { readonly pass: false; readonly input?: string; readonly copy?: true; readonly paste?: true };

/** Claude Code понимает ESC+CR как перевод строки. */
export const NEWLINE_INPUT = '\x1b\r';

export function keyAction(event: KeyInfo, mac: boolean): KeyAction {
  // keypress гасится вместе с keydown: иначе xterm шлёт по нему свой \r, и запрос уходит.
  if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey) return event.type === 'keydown' ? { pass: false, input: NEWLINE_INPUT } : { pass: false };
  if (event.type !== 'keydown' || mac) return { pass: true };
  // Копирование и вставка вне macOS: Ctrl+Shift+C/V, голый Ctrl+C - прерывание. На macOS Cmd+C/V выполняют пункты меню окна.
  const clipboard = event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
  if (clipboard && event.code === 'KeyC') return { pass: false, copy: true };
  if (clipboard && event.code === 'KeyV') return { pass: false, paste: true };
  return { pass: true };
}
