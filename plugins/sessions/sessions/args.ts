// Проверка аргументов команд и членов контракта `cyborg.sessions`. Граница плагинов типов не знает: вид, скрипт в странице и чужой плагин шлют что угодно,
// а запись в pty с негодным значением бросает исключение. Каналы `session:input` и `session:resize` решает pty-хост ядра (вид пишет в терминал по билету),
// здесь те же пределы для ввода, который идёт через плагин: `send`, `paste`, команды `sessions.write` и `sessions.resize`.
// Перенесено из src/main/session-args.ts ai-cyborg: номер сессии (целое счётчика) заменён строковым id.

import type { SessionLabelsPatch } from '@cyborg-plugins/contracts';

/** Id сессии: строка из букв, цифр, `_` и `-`, до 64 знаков (его же агент кладёт в имя своего файла). */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Предел одного сообщения ввода, в UTF-16 единицах строки JS. Вставка из буфера приходит от xterm одним сообщением (в режиме bracketed paste - целиком),
 * типичные большие вставки - логи и дифы до сотен килобайт. 1 МиБ даёт пятикратный запас над вставкой 200 КБ и ограничивает худший случай.
 * Больше предела - сообщение отбрасывается целиком, а не обрезается: обрезанная вставка (кусок команды без хвоста) опаснее, чем отсутствующая.
 */
export const MAX_INPUT_LENGTH = 1024 * 1024;

/** Размер терминала в ячейках: нижняя граница 1 (нулевой размер pty не принимает), верхняя 1000 (ioctl TIOCSWINSZ хранит размер в 16 битах). */
export const MIN_TERMINAL_SIZE = 1;
export const MAX_TERMINAL_SIZE = 1000;

/** Начальный запрос в argv агента: предел с большим запасом под ARG_MAX (1 МиБ на macOS). */
export const MAX_PROMPT_LENGTH = 100_000;

export interface ResizeArgs {
  readonly id: string;
  readonly cols: number;
  readonly rows: number;
}

/** Id сессии; иное - `null`. */
export function validateSessionId(id: unknown): string | null {
  return typeof id === 'string' && SESSION_ID.test(id) ? id : null;
}

const validSize = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= MIN_TERMINAL_SIZE && value <= MAX_TERMINAL_SIZE;

/** Ввод в сессию: id и строка не длиннее предела. Пустая строка допустима (ничего не пишет). Иное - `null`. */
export function validateInputArgs(id: unknown, data: unknown): { id: string; data: string } | null {
  const valid = validateSessionId(id);
  if (valid === null || typeof data !== 'string' || data.length > MAX_INPUT_LENGTH) return null;
  return { id: valid, data };
}

/** Размер терминала сессии: id и два целых 1..1000. Иное - `null`. */
export function validateResizeArgs(id: unknown, cols: unknown, rows: unknown): ResizeArgs | null {
  const valid = validateSessionId(id);
  if (valid === null || !validSize(cols) || !validSize(rows)) return null;
  return { id: valid, cols, rows };
}

/** Запрос на открытие сессии после проверки формы (каталоги ещё не сверены с проектами). */
export interface CreateInput {
  readonly cwd: string;
  readonly addDirs: readonly string[];
  readonly prompt?: string;
  readonly agent?: string;
  readonly resumeId?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Абсолютный путь без `\0` и сегментов `..`: ядро раскрывает `..` после символьной ссылки иначе, чем нормализация строки. */
export const isPlainPath = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && !value.includes('\0') && value.startsWith('/') && !value.split('/').includes('..');

/** Форма запроса на открытие сессии: `{ cwd, addDirs?, prompt?, agent?, resumeId? }`. Ошибка - строка с причиной. */
export function validateCreateInput(raw: unknown): CreateInput | string {
  if (!isRecord(raw)) return 'запрос на сессию не объект';
  const { cwd, addDirs = [], prompt, agent, resumeId } = raw;
  if (!isPlainPath(cwd)) return 'cwd: нужен абсолютный путь без «..»';
  if (!Array.isArray(addDirs) || addDirs.length > 64 || !addDirs.every(isPlainPath)) return 'addDirs: нужен список абсолютных путей без «..»';
  if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_LENGTH)) return `prompt: строка не длиннее ${String(MAX_PROMPT_LENGTH)} знаков`;
  if (agent !== undefined && (typeof agent !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(agent))) return 'agent: нужен id плагина-агента';
  if (resumeId !== undefined && (typeof resumeId !== 'string' || !SESSION_ID.test(resumeId))) return 'resumeId: id сессии не годится';
  return {
    cwd,
    addDirs: [...new Set(addDirs)],
    ...(typeof prompt === 'string' && prompt !== '' && { prompt }),
    ...(typeof agent === 'string' && { agent }),
    ...(typeof resumeId === 'string' && { resumeId }),
  };
}

const MAX_BINDING_TEXT = 500;
const BINDING_KINDS = ['task', 'mr'] as const;

/** Привязка из чужого плагина: форма и длины проверяются, лишние поля отбрасываются. */
function validateBinding(raw: unknown): { key: string; title: string; status?: string; url?: string } | string {
  if (!isRecord(raw)) return 'привязка не объект';
  const { key, title, status, url } = raw;
  const text = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_BINDING_TEXT;
  if (!text(key) || key === '') return 'key: непустая строка';
  if (!text(title)) return 'title: строка';
  if (status !== undefined && !text(status)) return 'status: строка';
  if (url !== undefined && !text(url)) return 'url: строка';
  return { key, title, ...(status !== undefined && { status }), ...(url !== undefined && { url }) };
}

/** Правка меток: `{ task?: привязка | null, mr?: привязка | null }`. Ошибка - строка с причиной. */
export function validateLabelsPatch(raw: unknown): SessionLabelsPatch | string {
  if (!isRecord(raw)) return 'метки не объект';
  const patch: { -readonly [K in keyof SessionLabelsPatch]: SessionLabelsPatch[K] } = {};
  for (const kind of BINDING_KINDS) {
    const value = raw[kind];
    if (value === undefined) continue;
    if (value === null) {
      patch[kind] = null;
      continue;
    }
    const binding = validateBinding(value);
    if (typeof binding === 'string') return `${kind}: ${binding}`;
    patch[kind] = binding;
  }
  return patch;
}

/** Управляющие символы (кроме перевода строки и табуляции) вычищаются: ESC закрыл бы вставку, и дальше текст пошёл бы в TUI клавишами. Перенесено из src/main/clean-text.ts. */
export function cleanMessage(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
}
