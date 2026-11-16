// Проверки аргументов удалённых сессий: порт src/main/remote/remote-args.ts, src/main/branch-name.ts и нужных кусков session-tools.ts / clean-text.ts ai-cyborg.
// Главный процесс аргументам из окна не доверяет (ADR-0002 п.5): ошибка - строка с причиной.
import { MAX_TEXT_BYTES } from './limits.ts';

const MAX_BRANCH_BYTES = 255;
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** Причина отказа по правилам `git check-ref-format --branch` плюс запрет ведущего «-»; null - имя допустимо. */
export function branchNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !name) return 'ветка - непустая строка';
  if (byteLength(name) > MAX_BRANCH_BYTES) return `ветка длиннее ${String(MAX_BRANCH_BYTES)} байт`;
  if (name.startsWith('-')) return 'ветка не может начинаться с «-»: git примет её за ключ';
  if (name === '@') return 'ветка не может называться «@»';
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'ветка содержит пробел, управляющий символ или один из ~ ^ : ? * [ \\';
  if (name.includes('..')) return 'ветка не может содержать «..»';
  if (name.includes('@{')) return 'ветка не может содержать «@{»';
  if (name.includes('//')) return 'ветка не может содержать «//»';
  if (name.startsWith('/') || name.endsWith('/')) return 'ветка не может начинаться или кончаться на «/»';
  if (name.endsWith('.')) return 'ветка не может кончаться на «.»';
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'компонент ветки не может начинаться с «.»';
    if (part.endsWith('.lock')) return 'компонент ветки не может кончаться на «.lock»';
  }
  return null;
}

export function validBranchName(name: unknown): name is string {
  return branchNameProblem(name) === null;
}

/** Управляющие символы (кроме перевода строки и табуляции) вычищаются: ESC закрыл бы вставку и дальше текст пошёл бы в TUI клавишами. */
export function cleanMessage(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
}

const SHELL_REFUSAL = 'текст не может начинаться с «!»: Claude Code выполнил бы его как команду оболочки без запроса разрешения';

/** Общие проверки промпта старта (ADR-0017 п.3, ADR-0019 п.8): ведущие «-» и «!», предел длины; null - годится. */
export function promptProblem(text: string, name: string, limitHint = ''): string | null {
  // Проверяется очищенный текст: ведущий управляющий символ вычищается позже и иначе открыл бы «!» или «-».
  const head = cleanMessage(text);
  if (head.startsWith('-')) return `${name} не может начинаться с «-»: claude примет его за ключ командной строки`;
  if (head.startsWith('!')) return name === 'prompt' ? SHELL_REFUSAL : `${name} не может начинаться с «!»: Claude Code выполнил бы его как команду оболочки`;
  if (byteLength(text) > MAX_TEXT_BYTES) return `${name} длиннее ${String(MAX_TEXT_BYTES)} байт${limitHint}`;
  return null;
}

/** Проект так, как его видит плагин: репозитории и хосты. */
export interface ProjectView {
  readonly repos: readonly string[];
  readonly hosts: readonly string[];
}

export interface RemoteCreateArgs {
  host: string;
  repo: string;
  branch: string;
  prompt?: string;
}

/** Аргументы создания сессии: хост из списка проекта, репозиторий из проекта, допустимая ветка; ошибка - строка с причиной. */
export function validateRemoteCreate(value: unknown, project: ProjectView | undefined): RemoteCreateArgs | string {
  if (!project || typeof value !== 'object' || value === null) return 'Некорректные аргументы remote:create';
  const { host, repo, branch, prompt } = value as Record<string, unknown>;
  if (typeof host !== 'string' || !project.hosts.includes(host)) return 'хост не из списка проекта';
  if (typeof repo !== 'string' || !project.repos.includes(repo)) return 'репозиторий не из проекта';
  const problem = branchNameProblem(branch);
  if (problem) return problem;
  const out: RemoteCreateArgs = { host, repo, branch: branch as string };
  if (prompt === undefined || prompt === null) return out;
  if (typeof prompt !== 'string') return 'задание - строка';
  const promptBad = promptProblem(prompt, 'задание');
  if (promptBad) return promptBad;
  const clean = cleanMessage(prompt);
  return clean ? { ...out, prompt: clean } : out;
}

/** Запуск человеком из интерфейса: задание он пишет в терминал сам, поле prompt не принимается (D-32). */
export function validateHumanRemoteCreate(value: unknown, project: ProjectView | undefined): RemoteCreateArgs | string {
  if (typeof value !== 'object' || value === null) return validateRemoteCreate(value, project);
  const { host, repo, branch } = value as Record<string, unknown>;
  return validateRemoteCreate({ host, repo, branch }, project);
}

/**
 * Адрес origin для клона на хосте: учётные данные в http(s)-адресе (`https://пользователь:токен@хост/…`) отбрасываются.
 * Иначе токен из локального `.git/config` лёг бы в `.git/config` клона на диске хоста и в аргументы `git clone`, которые видны в списке процессов (NFR-17001);
 * доступ к хостингу дают токены gh и glab (FR-17016). Пользователь `git` в `ssh://git@хост/…` не секрет и остаётся.
 */
export function hostCloneUrl(url: string): { url: string; stripped: boolean } {
  const m = /^(https?:\/\/)([^/?#]*)(.*)$/is.exec(url);
  const authority = m?.[2] ?? '';
  const at = m ? authority.lastIndexOf('@') : -1;
  return m && at >= 0 ? { url: (m[1] ?? '') + authority.slice(at + 1) + (m[3] ?? ''), stripped: true } : { url, stripped: false };
}

export const REMOTE_FS_OPS = ['list', 'read', 'root', 'branch', 'status', 'head', 'files'] as const;
export type RemoteFsOp = (typeof REMOTE_FS_OPS)[number];

/** Только читающие операции над клонами: правка файлов и смена ветки в список не входят. Идентификатор - строка (в ai-cyborg номер вкладки). */
export function validateRemoteFs(id: unknown, op: unknown): { id: string; op: RemoteFsOp } | null {
  if (typeof id !== 'string' || id === '' || !REMOTE_FS_OPS.includes(op as RemoteFsOp)) return null;
  return { id, op: op as RemoteFsOp };
}

/** Путь операции над клонами: абсолютный и без «..»; границу клонов держит демон. */
export function validateRemotePath(target: unknown): string | null {
  if (typeof target !== 'string' || !target.startsWith('/') || target.split('/').includes('..') || target.includes('\0')) return null;
  return target;
}

export const MAX_HITS = 500;

export interface MatchRange {
  start: number;
  end: number;
}

export interface LineHit {
  rel: string;
  line: number;
  text: string;
  range: MatchRange | null;
  sign?: '+' | '-';
}

export interface SearchReply {
  hits: LineHit[];
  truncated: boolean;
  cancelled?: true;
  error?: string;
}

/** Ответ поиска с хоста: форма проверяется, пути только относительные, число попаданий и длина строк ограничены. */
export function readSearchReply(value: unknown): SearchReply {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const hits = (Array.isArray(v.hits) ? v.hits.slice(0, MAX_HITS) : []).flatMap((item): LineHit[] => {
    const h = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const { rel, text, line, sign } = h;
    if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.split('/').includes('..') || typeof text !== 'string') return [];
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return [];
    const r = h.range as MatchRange | null;
    const range = r && Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end >= r.start ? { start: r.start, end: r.end } : null;
    return [{ rel: rel.slice(0, 4096), line, text: text.slice(0, 1000), range, ...(sign === '+' || sign === '-' ? { sign } : {}) }];
  });
  return {
    hits,
    truncated: v.truncated === true,
    ...(v.cancelled === true ? { cancelled: true as const } : {}),
    ...(typeof v.error === 'string' ? { error: v.error.slice(0, 500) } : {}),
  };
}

export { MAX_TEXT_BYTES };
