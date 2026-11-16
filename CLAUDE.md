## Цель

Cyborg Plugins - репозиторий плагинов для приложений на ядре Cyborg Harness (https://github.com/dex-it/cyborg-harness): каталог по назначению, бандлы (именованные наборы плагинов, ставятся пачкой), документация и её деплой. Первый потребитель - перенос приложения ai-cyborg в плагины (docs/guide/development/roadmap.md); дальше плагины добавляет кто угодно. Ядро и его контракты живут в cyborg-harness: здесь их не правят и не копируют.

## Сборка и гейты

Пока пакеты ядра не в реестре, нужен собранный клон cyborg-harness рядом (`npm ci --ignore-scripts && npm run build:packages` в нём) и `npm run harness:link` здесь.

- Проверка раскладки, карточек, бандлов - `npm run check`
- Проверка каждого плагина ядром (`cyborg-plugin check`) - `npm run check:plugins`
- Сборка плагинов - `npm run build` (в `dist/plugins/<id>`)
- Типы - `npm run typecheck` (скрипты и каждый плагин; TS 6)
- Тесты - `npm test` (node --test скриптов и фикстур, затем тесты каждого плагина); после `npm install` снова `npm run harness:link` (он предупредит, если ядро собрано давно); без `harness:link` один тест сборки бандла пропускается
- Страницы каталога сайта - `npm run docs:catalog`; в git они **не лежат** (`docs/guide/catalog/` в .gitignore), их строит сборка сайта; правка карточки, бандла, модели или матрицы страницы коммитить не требует
- Бандлы - `npm run bundle -- <id>|--all [--pack] [--out <каталог>]`
- Матрица паритета с ai-cyborg - `parity/matrix.json` (338 строк: требования, каналы, события, ключи, диалоги, файлы данных; владелец, задача, статус); `npm run parity [-- <клон ai-cyborg> [--write-missing]]`; CI сверяет с кодом ai-cyborg на якорном коммите; строка с владельцем `?` и статус allowlist без причины - ошибка `npm run check`
- Ресурсы плагина (assets/ -> assets.generated.ts) - `npm run embed-assets -- <каталог>|--all [--check]`; исходные расширения в assets/ запрещены (только `.txt`), свежесть модуля проверяет `npm run check`
- Пробелы контрактов относительно типов ядра - `npm run contracts:gap [-- --strict]`; модель - `plugins/planned-contracts.json` (запланированные плагины), замкнутость запланированных бандлов проверяет `npm run check`
- Метки GitHub - файл `.github/labels.json`, применяет `npm run sync-labels [-- --dry-run|--prune]` (система как в cyborg-harness: type, level, component, category, stage, priority, status, platform, effort)
- Новый плагин - `npm run new -- <категория> <id> ["Название"]`
- Сайт - `cd site && npm ci && npm run build && npm run verify`
- CI - `.github/workflows/ci.yml` (macOS и Linux; включает сквозной тест `scripts/test/pipeline.test.ts`), `docs-site.yml` (сайт), `release.yml` (бандлы по тегу `v*`), `drift.yml` (раз в неделю: ai-cyborg master против матрицы паритета)

## Карта

- `plugins/<категория>/<id>/` - плагины; перечень категорий и запланированных плагинов - `plugins/categories.json`; категория определяется только путём, в манифест она не пишется (манифест ядра не принимает чужих полей); каждый плагин - npm workspace (`plugins/*/*`), его npm-зависимости (`dependencies` в `package.json` плагина, например `@xterm/xterm` у `sessions`) ставит корневой `npm ci`, а `cyborg-plugin build` вкладывает их в бандл вида
- `plugins/<категория>/<id>/README.md` - карточка плагина: шапка `---` (title, summary, status, tags, needs), дальше описание с `##`
- `plugins/planned-contracts.json` - проектная модель контрактов запланированных плагинов (provides, requires, optional, consumes, нужные члены); готовый плагин из неё убирается
- `bundles/<id>.json` - бандл (`format: 1`, id равен имени файла, version, title, description, extends, plugins); `bundles/planned.json` - запланированные наборы
- `fixtures/` - пакет `@cyborg-plugins/fixtures` (npm workspace): подставные `claude`, `gh`, `glab`, `jira`, `ssh`, `shell`, медленный `git` (скрипты читают `fake.env` рядом: ядро не передаёт плагину переменные тестов), `toolbox()`, `fixtureRepo()`, `claudeHome()`; тесты - `fixtures/test/`; `parity/` - формат записанных сессий
- `contracts/` - пакет `@cyborg-plugins/contracts` (npm workspace): типы `cyborg.projects`, `cyborg.project-settings`, `cyborg.editor`, которых нет в `@cyborg-harness/contracts`; временные, переедут в ядро (cyborg-harness#256); скрипты запускают `cyborg-plugin` с `--declarations-package @cyborg-plugins/contracts`
- `templates/plugin/` - шаблон для `npm run new`; токены `__ID__` и `__TITLE__`
- `scripts/` - `check.ts`, `each-plugin.ts`, `bundle.ts`, `new-plugin.ts`, `gen-catalog.ts`, `link-harness.ts`, `sync-labels.ts`; `scripts/lib/` - каталог (`catalog.ts`), бандлы и полнота (`bundles.ts`), версии контрактов (`semver.ts`), метки (`labels.ts`), модель контрактов и пробелы (`design.ts`), ресурсы плагина (`embed-assets.ts`), матрица паритета (`parity.ts`), сборка бандла (`build-bundle.ts`), поиск `cyborg-plugin` (`harness.ts`); `scripts/test/` - тесты на временных репозиториях; `scripts/render-svg.cjs` - рендер SVG в PNG через Electron (значок, og.png)
- `docs/guide/` - страницы сайта; `docs/guide/catalog/` генерируется, руками не правится
- `site/` - сборка сайта (Astro и Starlight), устроена как сайт ядра; адрес и бренд - `site/site.config.mjs`
- `assets/` - `icon.svg` (значок, продолжает значок ядра), `og.svg` (источник `site/public/og.png`)

## Правила

- Плагин импортирует только `@cyborg-harness/contracts` и свои модули (проверяет `cyborg-plugin check`); `node:*`, `electron` и чужие плагины запрещены.
- Идентификатор плагина общий на весь репозиторий и равен имени каталога; `cyborg`, `cyborg.window`, `cyborg.workspace` заняты ядром. Контракты `cyborg.*` отдают только плагины поставки, сторонние берут свой префикс.
- Плагин, ставший готовым, убирают из `planned` своей категории; бандл, ставший готовым, - из `bundles/planned.json`.
- Бандл ссылается только на существующие плагины и должен быть полон: у каждого `requires` есть единственный поставщик нужной мажорной версии внутри бандла.
- Скрипты на TypeScript без сборки: импорты с расширением `.ts`, параметры-свойства конструктора и `enum` не писать (`erasableSyntaxOnly`).
- Тексты и документация на русском; дефис с пробелами вместо длинного тире, без эмодзи.
- В коммитах, PR и комментариях нет подписей Claude (Co-Authored-By, Generated with Claude Code, ссылки на сессию).

## Запреты

- `node_modules/`, `dist/`, `package-lock.json`, `site/package-lock.json` руками не править
- `docs/guide/catalog/` руками не править и не коммитить: его строит `npm run docs:catalog`
- Не копировать код ядра и не править контракты `cyborg.*` здесь: это `@cyborg-harness/contracts`
