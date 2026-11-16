// Проверка аргументов уведомления (перенос src/main/notify-args.ts ai-cyborg): поставщику сессий не доверяем.

/** Предел заголовка: у ядра он 120 символов (`NOTIFY_LIMITS.title`), у ai-cyborg было 200; длиннее ядро отказывает `Invalid`. */
export const TITLE_LENGTH = 120;
/** Предел текста: как в ai-cyborg (ядро принимает до 1000). */
export const BODY_LENGTH = 300;
/** Предел id сессии: он уходит аргументом команды клика. */
export const SESSION_ID_LENGTH = 200;

export interface NotifyArgs {
  sessionId: string;
  title: string;
  body: string;
}

const clip = (text: string, length: number): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

// Управляющие символы C0 (в том числе перевод строки и табуляция), DEL и C1: баннер ОС однострочный, а ESC-последовательность в нём - подделка вида.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;
const clean = (text: string): string => text.replace(CONTROL, ' ').trim();

/**
 * id сессии - непустая строка не длиннее предела, заголовок и текст - строки; управляющие символы заменяются пробелом, длина ограничена с многоточием.
 * Заголовок, пустой после очистки, или иное - null, уведомления нет.
 */
export function validateNotifyArgs(sessionId: unknown, title: unknown, body: unknown): NotifyArgs | null {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > SESSION_ID_LENGTH) return null;
  if (typeof title !== 'string' || typeof body !== 'string') return null;
  const cleanTitle = clean(title);
  if (!cleanTitle) return null;
  return { sessionId, title: clip(cleanTitle, TITLE_LENGTH), body: clip(clean(body), BODY_LENGTH) };
}
