import type { SessionBinding, SessionLabels } from '@cyborg-plugins/contracts';

// Общее для главной части и вида: что вид знает о вкладке и как из меток собирается заголовок. Только данные и чистые функции.
// Заголовок собирается в памяти и в документ вкладки не пишется: привязка задачи и MR на диск не попадает (FR-1015, FR-2014).

/** Состояние сессии для вкладки: ждёт запуска агента, работает, ждёт человека, вышла. */
export type TabState = 'starting' | 'working' | 'waiting' | 'exited';

/** Вкладка глазами вида (`sessions.tabs`). Ключ вкладки - документ: он переживает восстановление сессии, а id сессии при этом меняется. */
export interface TabInfo {
  readonly doc: string;
  /** Нет у вкладки прошлого запуска, которую ещё не поднимали. */
  readonly sessionId: string | null;
  /** Заголовок для человека: «Claude Code 1 · #12 Название · открыта». */
  readonly title: string;
  readonly agent: string;
  /** Текущий каталог сессии (после перехода в worktree - он); нет вестей - каталог запуска. */
  readonly cwd: string | null;
  readonly state: TabState;
  /** Почему ждёт человека: текст агента без содержимого запроса. */
  readonly reason?: string;
  /** Привязка к задаче и MR: для подсказки и кнопки возврата к списку. */
  readonly labels: SessionLabels;
  /** Прошлый запуск приложения, процесса нет: вкладку поднимает `sessions.restore`. */
  readonly previous: boolean;
}

const part = (binding: SessionBinding | undefined): string | undefined => (binding === undefined ? undefined : [binding.title, binding.status].filter((s) => s !== undefined && s !== '').join(' · '));

/**
 * Заголовок вкладки по меткам: «CC1 · #12 Название · открыта» (FR-1014) и то же для MR (FR-2013). Название и статус привязки даёт трекер, как их записать
 * (номер, `!` у MR GitLab, метки `workflow::…` через запятую), решает он. Привязок нет - заголовок без изменений.
 */
export function composeTitle(base: string, labels: SessionLabels): string {
  return [base, part(labels.task), part(labels.mr)].filter((s) => s !== undefined && s !== '').join(' · ');
}

/** Подсказка вкладки: заголовок, каталог и ссылки привязок. */
export function tabTooltip(tab: Pick<TabInfo, 'title' | 'cwd' | 'labels'>): string {
  return [tab.title, tab.cwd, tab.labels.task?.url, tab.labels.mr?.url].filter((s) => s !== undefined && s !== null && s !== '').join('\n');
}

/** Куда ведёт кнопка возврата из сессии, начатой по задаче или MR (src/renderer/panel-return.ts); у обычной сессии её нет. */
export interface ReturnTarget {
  readonly tab: 'tasks' | 'mrs';
  readonly key: string;
  readonly label: string;
  readonly title: string;
}

/** Короткая ссылка на объект трекера для подписи кнопки: первое слово названия привязки («#12», «!7», «PROJ-5»). */
const refOf = (binding: SessionBinding): string => binding.title.trim().split(/\s+/)[0] || binding.key;

export function returnTarget(labels: SessionLabels): ReturnTarget | null {
  if (labels.mr) {
    const ref = refOf(labels.mr);
    return { tab: 'mrs', key: labels.mr.key, label: `К ${ref} в списке`, title: `Открыть список MR/PR на ${ref}` };
  }
  if (labels.task) {
    const ref = refOf(labels.task);
    return { tab: 'tasks', key: labels.task.key, label: `К ${ref} в списке`, title: `Открыть список задач на ${ref}` };
  }
  return null;
}
