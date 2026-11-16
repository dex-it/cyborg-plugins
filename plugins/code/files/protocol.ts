import type { TreeMarkKind } from '@cyborg-harness/contracts';

// Что главная часть отдаёт виду командой `files.view`: только данные (проходят structuredClone), типы общие для главной части и вида.

/** Отметка строки: отметка файла от поставщика `cyborg.tree-decoration` или `changed` у каталога, внутри которого есть отмеченное. */
export type Mark = TreeMarkKind | 'changed';

/** Строка каталога: имя, род, отметка, ссылка (цель читаема). */
export type ViewEntry = readonly [name: string, kind: 'file' | 'dir' | 'link' | 'other', mark: Mark | null, link: boolean];

/** Корень дерева: подпись и подсказка от `cyborg.projects.roots`, ветка и число изменений от `cyborg.git` и `cyborg.tree-decoration`. */
export interface RootView {
  readonly path: string;
  readonly label: string;
  readonly hint: string;
  readonly collapsed: boolean;
  /** Ветка репозитория; `null` - не git или git не отвечает. */
  readonly branch: string | null;
  /** Ветку можно сменить из дерева: корень - репозиторий проекта (`cyborg.git.switch` принимает только такие). */
  readonly switchable: boolean;
  /** Число отмеченных путей (±N в строке корня). */
  readonly changes: number;
  /** Корень не прочитан: причина словами. */
  readonly error: string | null;
  /** Замечание без отказа: слежение не открылось (дерево работает, но обновляется по кнопке «Обновить»). */
  readonly notice: string | null;
  /** Раскрытые каталоги корня (в том числе сам корень): абсолютный путь -> записи. */
  readonly nodes: Readonly<Record<string, readonly ViewEntry[]>>;
}

/** Область дерева: проект целиком (репозитории проекта) или одна сессия (её корень первым). */
export interface ScopeInfo {
  readonly id: string;
  readonly label: string;
  readonly title: string;
}

export interface ViewReply {
  /** Запуск плагина: после перезагрузки плагина счёт `version` начинается заново, и вид не должен принять это за устаревший ответ. */
  readonly epoch: number;
  /** Растёт при любой перемене; вид отбрасывает ответ старее показанного. */
  readonly version: number;
  /** Область, чьё дерево в ответе: та, что просил вид, либо выбранная самим плагином. */
  readonly scope: string;
  /** Область «по умолчанию»: сессия, от которой событие пришло последним, иначе проект. */
  readonly auto: string;
  readonly scopes: readonly ScopeInfo[];
  /** Пояснение, когда корней нет (нет проекта, нет репозиториев); иначе `null`. */
  readonly hint: string | null;
  readonly roots: readonly RootView[];
}

export interface BranchList {
  readonly current: string | null;
  readonly local: readonly string[];
  readonly remote: readonly string[];
}

/** Сообщение главной части виду: что-то изменилось, вид просит `files.view`. */
export interface ChangedMessage {
  readonly changed: number;
}
