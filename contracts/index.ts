// Типы контрактов, которых ещё нет в @cyborg-harness/contracts: cyborg.projects, cyborg.project-settings, cyborg.editor, а также расширение cyborg.sessions 1.2.
// Только типы и дополнение карты Contracts, кода здесь нет: потребитель берёт файл через `import type`, а `cyborg-plugin check`
// с `--declarations-package @cyborg-plugins/contracts` не пускает отсюда значения в код плагина.
// Типы временные: после cyborg-harness#256 переезжают в пакет ядра, а этот пакет исчезает (README рядом).

import type { Sessions, Subscription } from '@cyborg-harness/contracts';

declare module '@cyborg-harness/contracts' {
  interface Contracts {
    'cyborg.projects': { 1: Projects };
    'cyborg.project-settings': { 1: ProjectSettings };
    'cyborg.editor': { 1: Editor };
  }
}

// ---------- cyborg.projects ----------

/** Проект: набор локальных репозиториев под одним именем. Только то, чем владеет `projects`; источники задач и хосты - секции `cyborg.project-settings`. */
export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Абсолютные физические пути (без символьных ссылок), без повторов, в порядке проекта. */
  readonly repos: readonly string[];
}

/** Что изменилось: проект добавлен, изменён, удалён или выбран другой (`projectId: null` - выбор снят). */
export interface ProjectsChange {
  readonly type: 'added' | 'updated' | 'removed' | 'selected';
  readonly projectId: string | null;
}

/** Корень дерева файлов сессии: путь, подпись и подсказка о том, откуда он взялся. */
export interface ProjectRoot {
  readonly path: string;
  readonly label: string;
  readonly hint: string;
}

/** Что нужно знать о сессии, чтобы построить корни её дерева. `repo` - где сессия стартовала, `root` - её текущий корень (тот же репозиторий, его worktree или другой репозиторий проекта). */
export interface RootsRequest {
  readonly repo: string;
  readonly root: string;
  /** Проект, чьи репозитории берутся; не назван - проект, которому принадлежит `repo`, иначе выбранный. */
  readonly projectId?: string;
}

/**
 * `cyborg.projects` 1, кратность one, поставщик `projects`.
 * Изменения идут не через контракт: записи меняет владелец своим диалогом, остальные вызывают команды `projects.new`, `projects.edit` и `projects.select`.
 */
export interface Projects {
  /** Все проекты воркспейса. */
  list(): Promise<ProjectInfo[]>;
  /** Выбранный проект окна; не выбран - `null`. */
  selected(): Promise<ProjectInfo | null>;
  /** Есть ли выбранный проект: источник `enabled` для пунктов меню (`contributes.menus`). */
  hasSelected(): Promise<boolean>;
  /** Корни дерева файлов сессии: свой корень первым, затем остальные репозитории проекта; путь не повторяется. */
  roots(request: RootsRequest): Promise<ProjectRoot[]>;
  /** События проектов; прошлое не повторяется. Слушатель, бросивший исключение, соседям не мешает. */
  onChange(listener: (change: ProjectsChange) => void): Subscription;
}

// ---------- cyborg.project-settings ----------

/** Поле секции. Значения: `boolean` - булево, `text` - строка, `list` - список строк (в форме строка через запятую). */
export type SettingsField =
  | { readonly id: string; readonly kind: 'boolean'; readonly label: string; readonly hint?: string }
  | { readonly id: string; readonly kind: 'text'; readonly label: string; readonly placeholder?: string; readonly hint?: string }
  | { readonly id: string; readonly kind: 'list'; readonly label: string; readonly placeholder?: string; readonly hint?: string };

/** Секция формы свойств проекта от плагина-поставщика: заголовок и поля; значения хранит поставщик в своём разделе. */
export interface SettingsSection {
  /** Идентификатор секции: `trackers`, `ssh`; уникален среди поставщиков. */
  readonly id: string;
  readonly title: string;
  /** Порядок в форме; по умолчанию 1000. */
  readonly order?: number;
  readonly fields: readonly SettingsField[];
}

/** Значения секции: ключи - `id` полей. Секретов в форме нет: хранится выбор и ссылка, а не значение. */
export type SettingsValues = Readonly<Record<string, unknown>>;

/**
 * `cyborg.project-settings` 1, кратность many: контракт объявляет и опрашивает `projects`, поставляют `trackers`, `remote-sessions` и другие.
 * Проект, которого ещё нет (форма «Новый проект»), - `projectId: null`: поставщик отдаёт значения по умолчанию.
 */
export interface ProjectSettings {
  /** Описание секции: заголовок и поля. */
  section(): Promise<SettingsSection>;
  /** Значения секции для проекта; проекта нет или значений нет - значения по умолчанию. */
  load(projectId: string | null): Promise<SettingsValues>;
  /** Ошибки значений, по строке на ошибку; пустой список - значения годны. `projects` не сохраняет проект, пока хоть один поставщик отвечает ошибкой. */
  validate(projectId: string | null, values: SettingsValues): Promise<string[]>;
  /** Сохраняет значения после того, как проект сохранён (у нового проекта `projectId` уже есть). Секция, чьи значения не изменились, получает тот же вызов: сравнивает поставщик. */
  save(projectId: string, values: SettingsValues): Promise<void>;
  /** Значения секции у проекта изменились по причине вне формы; слушатель получает `projectId`. */
  onChange(listener: (projectId: string) => void): Subscription;
}

// ---------- cyborg.editor ----------

/** Что открыть в редакторе. */
export interface EditRequest {
  readonly title: string;
  readonly text: string;
  /** Подсветка и разбор; по умолчанию `text`. */
  readonly language?: 'json' | 'markdown' | 'text';
}

/** Что человек сделал с текстом: сохранил (и что получилось) или закрыл без сохранения. */
export type EditResult = { readonly saved: true; readonly text: string } | { readonly saved: false };

/** `cyborg.editor` 1, кратность one, поставщик `viewer`: редактор документов; плагину, которому он нужен, не надо встраивать свой. */
export interface Editor {
  /** Открывает текст; кнопка «Сохранить» возвращает правленый текст без проверки. */
  open(request: EditRequest): Promise<EditResult>;
  /**
   * Открывает текст с проверкой по схеме (подмножество JSON Schema ядра): текст, не прошедший её, остаётся в редакторе с замечаниями, а не возвращается.
   * Функция проверки через границу плагинов не проходит, поэтому проверка - данные, а не обратный вызов.
   */
  openWithValidation(request: EditRequest & { readonly schema: Readonly<Record<string, unknown>> }): Promise<EditResult>;
}

// ---------- cyborg.sessions 1.2 ----------

/** Привязка сессии к задаче или MR трекера. Живёт только в памяти плагина `sessions` (FR-1015, FR-2014): после перезапуска приложения её нет. */
export interface SessionBinding {
  /** Ключ объекта в трекере: номер задачи или MR, ключ Jira; трекер сам делает его уникальным в разрезе проекта (общий remote у двух проектов их сессий не смешивает). Вместе с видом (`task` или `mr`) называет объект: одна сессия на объект. */
  readonly key: string;
  /** Название для заголовка вкладки. */
  readonly title: string;
  /** Статус для заголовка («открыта», «закрыта», метки); обновляет трекер по мере обновления панели. */
  readonly status?: string;
  /** Ссылка на объект в трекере. */
  readonly url?: string;
}

/** Виды привязки: задача и MR. */
export type SessionBindingKind = 'task' | 'mr';

/** Метки сессии: сегодня это привязка к задаче и к MR; новое поле меток - минорная версия. */
export interface SessionLabels {
  readonly task?: SessionBinding;
  readonly mr?: SessionBinding;
}

/** Правка меток: поле со значением ставит привязку, `null` снимает её, не названное - не трогает. */
export type SessionLabelsPatch = { readonly [K in SessionBindingKind]?: SessionBinding | null };

/** Что нужно, чтобы открыть сессию. Каталоги проверяет `sessions` по репозиториям проектов (`cyborg.projects`). */
export interface SessionCreateRequest {
  /** Рабочий каталог: репозиторий одного из проектов. */
  readonly cwd: string;
  /** Дополнительные каталоги (`--add-dir`): тоже репозитории проектов. */
  readonly addDirs?: readonly string[];
  /** Первый запрос человека; пустой - сессия ждёт ввода. */
  readonly prompt?: string;
  /** Плагин-агент (`id` поставщика `cyborg.agent`); не назван - первый найденный по порядку id. */
  readonly agent?: string;
  /** Продолжить прошлую сессию агента (`id` из `history`). */
  readonly resumeId?: string;
  /** Привязка к задаче или MR с самого начала: вкладка получает заголовок без гонки с `setLabels`. */
  readonly labels?: SessionLabels;
}

/** Открытая сессия. */
export interface SessionHandle {
  /** Устойчивый id сессии у `sessions`, тот же, что `SessionEvent.sessionId`. */
  readonly sessionId: string;
  /** Подпись для человека (заголовок вкладки). */
  readonly title: string;
}

/** Параметры вставки. */
export interface PasteOptions {
  /** После вставки отправить Enter отдельной записью (через паузу: пакет «текст и Enter» TUI вправе принять за вставку). */
  readonly submit?: boolean;
}

/**
 * `cyborg.sessions` 1.2, кратность one, поставщик `sessions`: расширение интерфейса ядра (`Sessions`: `onChange`, `reveal`) членами каталога контрактов,
 * которых в типах ядра ещё нет ([cyborg-harness#257](https://github.com/dex-it/cyborg-harness/issues/257)). Типы временные и переедут в пакет ядра.
 * Потребитель берёт поставщика как `Remote<SessionsV12>` и проверяет, что нужный член есть: поставщик 1.0 и 1.1 их не даёт.
 */
export interface SessionsV12 extends Sessions {
  /** У поставщика 1.2 `reveal` есть всегда (в типе ядра он необязателен ради 1.0). */
  reveal(sessionId: string): Promise<void>;
  /** Открывает сессию агента. Каталог вне репозиториев проектов, агент, которого нет или который не найден, и негодный `resumeId` - отказ с понятным текстом. */
  create(request: SessionCreateRequest): Promise<SessionHandle>;
  /** Ввод в сессию как с клавиатуры: текст идёт в pty без обёртки, перевод строки в нём - нажатие Enter. Не больше 1 МиБ; сессии нет или она вышла - отказ. */
  send(sessionId: string, text: string): Promise<void>;
  /** Вставка текста в строку ввода агента (bracketed paste) без Enter, если не просили `submit`. Управляющие символы из текста убираются: ESC закрыл бы вставку. */
  paste(sessionId: string, text: string, options?: PasteOptions): Promise<void>;
  /** Метки сессии; сессии нет (не этого запуска) - `null`. */
  labels(sessionId: string): Promise<SessionLabels | null>;
  /** Меняет метки (только в памяти) и возвращает итог. Привязку к тому же объекту, которую держала другая сессия, эта забирает себе: объект трекера - у одной сессии. Сессии нет - отказ. */
  setLabels(sessionId: string, patch: SessionLabelsPatch): Promise<SessionLabels>;
  /** Живая сессия, привязанная к объекту трекера; нет такой или она вышла - `null`: привязка выходом снимается. */
  find(kind: SessionBindingKind, key: string): Promise<string | null>;
  /** Идёт ли живая сессия, запущенная с каталогом `root` (рабочим или из `--add-dir`): git не меняет ветку под работающей сессией. Текущий каталог после перехода в worktree не считается. */
  uses(root: string): Promise<boolean>;
}
