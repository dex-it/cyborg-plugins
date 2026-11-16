// Типы контрактов, которых ещё нет в @cyborg-harness/contracts: cyborg.projects, cyborg.project-settings, cyborg.editor.
// Только типы и дополнение карты Contracts, кода здесь нет: потребитель берёт файл через `import type`, а `cyborg-plugin check`
// с `--declarations-package @cyborg-plugins/contracts` не пускает отсюда значения в код плагина.
// Типы временные: после cyborg-harness#256 переезжают в пакет ядра, а этот пакет исчезает (README рядом).

import type { Subscription } from '@cyborg-harness/contracts';

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
