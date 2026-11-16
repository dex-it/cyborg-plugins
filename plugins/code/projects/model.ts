// Чистая модель проектов: проверка состояния при сохранении, чтение раздела, пути. Ни ОС, ни ядра: тесты идут без ядра.
// Источник - ai-cyborg: src/main/projects.ts и validateProjectsState (trackers.ts); из проекта убраны то, что теперь у других плагинов:
// источники задач и Jira (trackers, M-13) и хосты SSH (remote-sessions, M-05) приходят секциями `cyborg.project-settings`.

export interface Project {
  id: string;
  name: string;
  description: string;
  /** Абсолютные физические пути, без повторов, в порядке проекта (FR-10004). */
  repos: string[];
}

export interface ProjectsState {
  projects: Project[];
  lastProjectId: string | null;
}

/** Предел числа проектов и репозиториев: защита от файла, присланного вместе с воркспейсом. */
export const MAX_PROJECTS = 200;
export const MAX_REPOS = 64;

/** Путь без разделителей-управляющих и сегментов `..`: ядро раскрывает `..` после символьной ссылки иначе, чем нормализация строки (allowed-paths.ts ai-cyborg). */
export function isPlainPath(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !value.includes('\0') && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) && !value.split(/[\\/]/).includes('..');
}

/** Путь лежит в каталоге или совпадает с ним: границей служит сегмент пути, поэтому `/repo-evil` не внутри `/repo`. */
export function isInside(child: string, root: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const [c, r] = [norm(child), norm(root)];
  if (r === '/') return c.startsWith('/');
  return c === r || c.startsWith(`${r}/`);
}

export type Checked = { readonly ok: true; readonly state: ProjectsState } | { readonly ok: false; readonly error: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Состояние проектов из `projects.save`: проект - объект с непустыми `id` и `name`, `repos` - абсолютные пути без повторов; лишние ключи отбрасываются.
 * Ответ называет причину, а не просто «не годится»: человек видит её в диалоге. Выбранный проект должен существовать.
 */
export function validateProjectsState(value: unknown): Checked {
  if (!isObject(value)) return { ok: false, error: 'Некорректное состояние проектов' };
  if (!Array.isArray(value.projects)) return { ok: false, error: 'Поле projects не массив' };
  if (value.projects.length > MAX_PROJECTS) return { ok: false, error: `Проектов не больше ${MAX_PROJECTS}` };
  const projects: Project[] = [];
  const ids = new Set<string>();
  for (const raw of value.projects as unknown[]) {
    if (!isObject(raw)) return { ok: false, error: 'Проект не объект' };
    const { id, name, description, repos } = raw;
    if (typeof id !== 'string' || id.trim() === '') return { ok: false, error: 'У проекта нет идентификатора' };
    if (ids.has(id)) return { ok: false, error: `Идентификатор проекта повторяется: ${id}` };
    ids.add(id);
    if (typeof name !== 'string' || name.trim() === '') return { ok: false, error: 'Нужно название проекта' };
    if (description !== undefined && typeof description !== 'string') return { ok: false, error: `Описание проекта «${name.trim()}» не строка` };
    if (!Array.isArray(repos) || repos.length > MAX_REPOS) return { ok: false, error: `Репозитории проекта «${name.trim()}»: нужен список не длиннее ${MAX_REPOS}` };
    const bad = (repos as unknown[]).find((r) => !isPlainPath(r));
    if (bad !== undefined) return { ok: false, error: `Репозиторий проекта «${name.trim()}»: нужен полный путь без «..», получено ${JSON.stringify(bad)}` };
    projects.push({ id, name: name.trim(), description: typeof description === 'string' ? description : '', repos: [...new Set(repos as string[])] });
  }
  const last = value.lastProjectId ?? null;
  if (last !== null && (typeof last !== 'string' || !ids.has(last))) return { ok: false, error: 'Выбранного проекта нет среди проектов' };
  return { ok: true, state: { projects, lastProjectId: last } };
}

/** Раздел `settings.projects` как он лежит в слое: негодные проекты отбрасываются поштучно, остальные остаются (читающий не ломает окно). Пути уже физические: канонизируются при записи. */
export function readProjects(section: unknown): Project[] {
  const items = isObject(section) && Array.isArray(section.items) ? (section.items as unknown[]) : [];
  const out: Project[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (!isObject(raw) || typeof raw.id !== 'string' || raw.id === '' || seen.has(raw.id) || typeof raw.name !== 'string' || raw.name.trim() === '') continue;
    seen.add(raw.id);
    const repos = Array.isArray(raw.repos) ? [...new Set((raw.repos as unknown[]).filter(isPlainPath))] : [];
    out.push({ id: raw.id, name: raw.name, description: typeof raw.description === 'string' ? raw.description : '', repos });
  }
  return out;
}

/** Что не так с записью проектов: причина для человека (FR-CH-2007, решение D-00: копия файла - забота ядра). */
export interface ProjectsProblem {
  /** corrupt - файл воркспейса не разобран, ядро хранит копию; unreadable - прочитать не удалось (права, ошибка ввода-вывода); refused - ядро отказало в записи по иной причине; roots - ядро не приняло какие-то каталоги проектов как корни. */
  kind: 'corrupt' | 'unreadable' | 'refused' | 'roots';
  /** Подробности: причина разбора, код ошибки чтения или текст отказа ядра. */
  detail: string;
  /** corrupt: путь копии исходных байт рядом с файлом воркспейса, если он известен. */
  copy?: string;
}

/** По тексту отказа ядра при записи раздела: не разобранный файл (повреждение) или иной отказ (только чтение, формат новее). */
export function problemFromRefusal(message: string): ProjectsProblem {
  const broken = /не разобран|корень не объект|SyntaxError|Unexpected (token|end|non-whitespace)|in JSON|valid JSON/i.test(message);
  return { kind: broken ? 'corrupt' : 'refused', detail: message };
}
