# @cyborg-plugins/contracts

Типы контрактов `cyborg.projects`, `cyborg.project-settings` и `cyborg.editor` и расширения `cyborg.sessions` 1.2 (`SessionsV12`) и `cyborg.git` 1.1 (`GitV11`). Только типы: `declare module '@cyborg-harness/contracts'` дополняет карту `Contracts`, кода в пакете нет.

## Типы временные

В `@cyborg-harness/contracts` этих трёх контрактов пока нет: их описывает каталог контрактов ядра, но в типах они не объявлены (задача ядра [cyborg-harness#256](https://github.com/dex-it/cyborg-harness/issues/256)). Чтобы перенос не ждал другого репозитория, плагины берут объявления отсюда (решение 11 в [решениях по переносу](https://dex-it.github.io/cyborg-plugins/development/decisions/)). Когда #256 выйдет, типы **переезжают в пакет ядра**, а этот пакет удаляется вместе с флагом `--declarations-package` в скриптах репозитория. Набор членов уточнён по коду ai-cyborg и может измениться при переезде: если ядро примет другие имена, правятся плагины репозитория.

## Как подключать

Плагин берёт типы только через `import type`:

```ts
import type { ProjectInfo } from '@cyborg-plugins/contracts';
```

`cyborg-plugin check`, `build` и `delivery` скрипты репозитория запускают с `--declarations-package @cyborg-plugins/contracts`: значения из этого пакета в код плагина не пускаются.

## Что внутри

| Контракт | Кратность | Объявляет и опрашивает | Поставщики | Члены |
|---|---|---|---|---|
| `cyborg.projects` 1 | one | `projects` | `projects` | `list`, `selected`, `hasSelected`, `roots`, `onChange` |
| `cyborg.project-settings` 1 | many | `projects` | `trackers`, `remote-sessions` и другие | `section`, `load`, `validate`, `save`, `onChange` |
| `cyborg.editor` 1 | one | `viewer` | `viewer` | `open`, `openWithValidation` |
| `cyborg.sessions` 1.2 | one | `sessions` | `sessions` | `onChange`, `reveal` (типы ядра) и `create`, `send`, `paste`, `labels`, `setLabels`, `find`, `uses` (`SessionsV12`) |
| `cyborg.git` 1.1 | one | `git` | `git` | `status`, `onChange` (типы ядра) и `root`, `branch`, `headContent`, `branches`, `switch`, `remotes`, `files` (`GitV11`) |

Отличия от проектной модели `plugins/planned-contracts.json` и от каталога контрактов ядра:

- `cyborg.projects`: добавлен `hasSelected` (булев член для `enabled` пункта меню) и корни дерева названы `roots(request)`, как `treeRoots` в ai-cyborg; `get`, `active`, `ownerOf` из каталога ядра не взяты, потому что `selected` и `list` покрывают то, что нужно потребителям из переноса.
- `cyborg.project-settings`: к `section`, `validate`, `onChange` добавлены `load` и `save`: в ai-cyborg проект сохраняется вместе с источниками, а после переноса секцию хранит поставщик.
- `cyborg.editor`: проверка передаётся схемой, а не функцией, потому что функция границу плагинов не пересекает.

### cyborg.sessions 1.2

В ядре есть `Sessions` с `onChange` и `reveal` (1.0 и 1.1); остальные члены каталога ([cyborg-harness#257](https://github.com/dex-it/cyborg-harness/issues/257)) объявляет здесь интерфейс `SessionsV12 extends Sessions`: карта `Contracts` ядра не меняется (запись `cyborg.sessions` там уже есть, дополнить её другим типом нельзя), поставщик `sessions` отдаёт контракт версии `1.2`, а потребитель берёт его как `Remote<SessionsV12>` и проверяет, что нужный член есть:

```ts
const sessions = ctx.contracts.get('cyborg.sessions', 1) as Remote<SessionsV12> | undefined;
if (typeof sessions?.uses === 'function') await sessions.uses(root);
```

Потребитель с `requires: { "cyborg.sessions": "^1.2" }` активируется только при поставщике 1.2.

- `labels`, `setLabels`, `find`: привязка сессии к задаче и MR трекера (`SessionBinding`); только в памяти поставщика (FR-1015, FR-2014), в `state` и на диск не пишется. Членов `setLabels` и `find` не было в проектной модели (там только `labels`): одного чтения мало, чтобы трекер поставил привязку и нашёл сессию задачи; модель дополнена.
- `send` пишет в сессию как с клавиатуры, `paste` вставляет текст в строку ввода (bracketed paste), `submit` отправляет Enter отдельной записью.
- `uses(root)`: живая сессия запущена с этим каталогом (рабочим или из `--add-dir`); текущий каталог после перехода в worktree не считается.
- `create` проверяет каталоги по репозиториям проектов (`cyborg.projects`) и возвращает `{ sessionId, title }`.

### cyborg.git 1.1

В ядре есть `Git` только с `status` и `onChange` (1.0, черновик PL-04); остальные семь членов каталога ([cyborg-harness#258](https://github.com/dex-it/cyborg-harness/issues/258)) объявляет здесь интерфейс `GitV11 extends Git`: карта `Contracts` ядра не меняется (запись `cyborg.git` там уже есть), поставщик `git` отдаёт контракт версии `1.1`, а потребитель берёт его как `Remote<GitV11>` и проверяет, что нужный член есть:

```ts
const git = ctx.contracts.get('cyborg.git', 1) as Remote<GitV11> | undefined;
if (typeof git?.headContent === 'function') await git.headContent(file);
```

Потребитель с `requires: { "cyborg.git": "^1.1" }` активируется только при поставщике 1.1.

- `root`, `branch`, `headContent`, `remotes`, `files`: читающие запросы `src/main/git.ts` ai-cyborg; ошибка git даёт пустой ответ (`null`, пустой список), как там.
- `branches(root)` и `switch(root, branch)`: только репозитории проектов (`cyborg.projects`); `switch` отказывает `{ error }` при работающей сессии (`cyborg.sessions.uses`), при `filter.*`, partial clone и отказе самого git. Имя ветки берётся только из списка веток.
- Все члены с путём объявлены с `guard` `fs.read` на первый аргумент.
- Результат смены - `GitSwitchResult` (`{}` или `{ error }`), а не исключение: так отдавал канал `git:switch` в ai-cyborg.
- `status` отвечает `null` вне репозитория (в ai-cyborg пустой объект) и отказом, если защита от фильтров репозитория не смогла собрать их ключи.
